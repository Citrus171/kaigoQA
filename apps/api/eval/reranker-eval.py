#!/usr/bin/env python3
"""out/30: Workers AI bge-reranker-base で検索精度を上げられるか検証

Phase 1（生成不要）: bge-m3 cosine top-30 → reranker で並べ替え → top-N gid率 比較
Phase 2（改善時）: rerank後 top-1 親文書で cloud 再生成 → 全ref judge → 2×2
"""
import json, os, time, math, re as _re, sys
import requests
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT  = os.path.join(HERE, "out")

env_path = os.path.join(HERE, "..", ".env")
if os.path.exists(env_path):
    for line in open(env_path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

CF_ACC       = os.environ["CF_ACCOUNT_ID"]
CF_TOK       = os.environ["CF_API_TOKEN"]
RERANK_URL   = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACC}/ai/run/@cf/baai/bge-reranker-base"

OPENCODE_KEY = os.environ["OPENCODE_API_KEY"]
OPENCODE_URL = "https://opencode.ai/zen/go/v1/chat/completions"
CLOUD_MODEL  = os.environ.get("OPENCODE_MODEL", "deepseek-v4-flash")

ORK          = os.environ["OPENROUTER_API_KEY"]
JUDGE_MODEL  = os.environ.get("JUDGE_MODEL", "openai/gpt-4o")
JUDGE_URL    = "https://openrouter.ai/api/v1/chat/completions"

OLLAMA_URL   = "http://localhost:11434/api/embed"
EMBED_MODEL  = "bge-m3"

GOLD_PATH    = os.path.join(DATA, "routing-gold-a.jsonl")
EMBED_CACHE  = os.path.join(DATA, "rag-corpus-embeddings.json")
RESULT_MD    = os.path.join(OUT, "30-reranker.md")
RERANK_CACHE = os.path.join(DATA, "rag-rerank-scores.json")

RETRIEVAL_FAILURE_IDS = [
    "gold-A-006", "gold-A-013", "gold-A-014", "gold-A-027",
    "gold-A-030", "gold-A-038", "gold-A-039", "gold-A-042",
]

K_COARSE = 30
NS = [1, 3]
ORACLE_CLOUD_GOOD_PCT = 61.0
ORACLE_M_REF = 4.9

DO_PHASE2 = "--phase2" in sys.argv

EDGE_SYSTEM_PROMPT = (
    "あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で簡潔に(2〜3文)答えてください。"
    "事実が確認できない場合や施設固有の情報は推測せず「施設にご確認ください」と述べること。"
    "医療診断・投薬指示・法令の断定はしないこと。"
)


def cos(a, b):
    d = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return d / (na * nb) if na and nb else 0.0


def isgood(v):
    return bool(v) and v.get("factual") and v.get("sufficient") and not v.get("overreach")


def embed_query(text):
    r = requests.post(OLLAMA_URL, json={"model": EMBED_MODEL, "input": [text]}, timeout=600)
    r.raise_for_status()
    return r.json()["embeddings"][0]


def judge(query, answer, refs):
    ref_text = "\n".join(f"- {pt}" for pt in refs)
    prompt = f"""あなたは日本の介護保険制度に精通した審査員です。AIの回答を厳格に採点してください。

質問: {query}
正解の要点（この事実に照らして採点）:
{ref_text}

AIの回答: {answer}

次のキーを持つJSONのみを返答（前置き・コードフェンス不要）:
{{"factual": boolean, "overreach": boolean, "sufficient": boolean,
 "category": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated", "reason": "30字以内"}}"""
    resp = requests.post(JUDGE_URL,
                         headers={"Authorization": f"Bearer {ORK}",
                                  "Content-Type": "application/json"},
                         json={"model": JUDGE_MODEL, "temperature": 0,
                               "messages": [{"role": "user", "content": prompt}]},
                         timeout=120)
    m = _re.search(r"\{[\s\S]*\}", resp.json()["choices"][0]["message"]["content"])
    o = json.loads(m.group(0))
    return {k: (o.get(k) in (True, "true")) for k in ("factual", "overreach", "sufficient")} | {
        "category": o.get("category", "ok"), "reason": str(o.get("reason", ""))}


def gen_cloud(query, refs):
    ref_text = "\n".join(f"- {pt}" for pt in refs)
    sys_p = EDGE_SYSTEM_PROMPT + f"\n\n回答の参考情報（介護保険の事実）:\n{ref_text}"
    r = requests.post(OPENCODE_URL,
                      headers={"Authorization": f"Bearer {OPENCODE_KEY}",
                               "Content-Type": "application/json"},
                      json={"model": CLOUD_MODEL,
                            "messages": [{"role": "system", "content": sys_p},
                                         {"role": "user", "content": query}]},
                      timeout=120)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()


def load_gold():
    return {json.loads(l)["id"]: json.loads(l) for l in open(GOLD_PATH) if l.strip()}


def build_corpus(gold_dict):
    corpus = []
    for g in gold_dict.values():
        for pt in (g.get("referencePoints") or []):
            corpus.append({"src_id": g["id"], "text": pt})
    return corpus


def load_corpus_embeds():
    print(f"[embed] cache hit: {EMBED_CACHE}")
    return json.load(open(EMBED_CACHE))["embeddings"]


def bge_cosine_topk(query, corpus, corpus_embeds, k):
    q_emb = embed_query(query)
    scores = [(i, cos(q_emb, ce)) for i, ce in enumerate(corpus_embeds)]
    scores.sort(key=lambda x: -x[1])
    return [(corpus[si]["src_id"], corpus[si]["text"], sc) for si, sc in scores[:k]]


def rerank(query, candidates):
    """Workers AI bge-reranker-base。candidates=[(src_id, text, cos_sim), ...]
    Returns: [(src_id, text, rerank_score), ...] sorted by rerank_score desc"""
    contexts = [{"text": text} for _, text, _ in candidates]
    resp = requests.post(RERANK_URL,
                         headers={"Authorization": f"Bearer {CF_TOK}"},
                         json={"query": query, "contexts": contexts, "top_k": len(contexts)},
                         timeout=60)
    resp.raise_for_status()
    body = resp.json()
    if not body.get("success"):
        raise RuntimeError(f"rerank API error: {body.get('errors')}")
    items = body["result"]["response"]
    results = []
    for item in items:
        idx = item["id"]
        src_id, text, _ = candidates[idx]
        results.append((src_id, text, item["score"]))
    return results


def gid_rate(top_results_list, N):
    """top-N unique src_id に自質問の gid が含まれる率"""
    hits = 0
    total = 0
    for gid, top in top_results_list:
        unique_srcs = list(dict.fromkeys([s for s, _, _ in top]))  # score order, dedup
        if gid in unique_srcs[:N]:
            hits += 1
        total += 1
    return hits, total


def parent_refs_topN(gold_dict, top_results, N):
    """top results の score 順 unique src_id 上位 N の親文書"""
    unique_srcs = list(dict.fromkeys([s for s, _, _ in top_results]))
    top_n = unique_srcs[:N]
    refs = []
    for src_id in top_n:
        for pt in (gold_dict.get(src_id, {}).get("referencePoints") or []):
            if pt not in refs:
                refs.append(pt)
    return refs, top_n


def phase1(gold_dict, corpus, corpus_embeds, edge_qs):
    print(f"\n=== Phase 1: bge-m3 cosine vs reranker (k={K_COARSE}) ===")

    bge_results = {}
    rerank_results = {}
    print(f"bge-m3 cosine top-{K_COARSE} for all questions ...")
    for gid, g in edge_qs:
        bge_results[gid] = bge_cosine_topk(g["query"], corpus, corpus_embeds, K_COARSE)

    # rerank (with cache)
    if os.path.exists(RERANK_CACHE):
        print(f"[rerank] cache hit: {RERANK_CACHE}")
        cached = json.load(open(RERANK_CACHE))
        rerank_results = {gid: [(s, t, sc) for s, t, sc in items] for gid, items in cached.items()}
    else:
        cache = {}
        print(f"reranking {len(edge_qs)} questions via Workers AI ...")
        for i, (gid, g) in enumerate(edge_qs):
            rerank_results[gid] = rerank(g["query"], bge_results[gid])
            cache[gid] = [(s, t, float(sc)) for s, t, sc in rerank_results[gid]]
            if (i + 1) % 10 == 0:
                print(f"  rerank {i+1}/{len(edge_qs)}")
        json.dump(cache, open(RERANK_CACHE, "w"), ensure_ascii=False)
        print(f"[rerank] cached: {RERANK_CACHE}")

    # compute gid rates and full-coverage
    print("\n| 指標 | bge-m3 cosine | reranker (bge-reranker-base) |")
    print("|---|---|---|")
    bge_top = [(gid, bge_results[gid]) for gid, _ in edge_qs]
    rr_top = [(gid, rerank_results[gid]) for gid, _ in edge_qs]

    r = {}
    for label, results in [("bge", bge_top), ("rerank", rr_top)]:
        r[label] = {}
        for N in NS:
            hits, total = gid_rate(results, N)
            r[label][f"gid@{N}"] = (hits, total, hits / total * 100)

        # full-coverage は top-N の親文書で自質問の全refが揃うか
        # 実質的に：rerank後に自質問の親を N に引けて、かつそれが full-coverage か
        # ここでは簡易的に top-3 unique src_id の gid 率で近似

    # print table
    for N in NS:
        bge_h, bge_t, bge_p = r["bge"][f"gid@{N}"]
        rr_h, rr_t, rr_p = r["rerank"][f"gid@{N}"]
        print(f"| top-{N} gid含有率 | {bge_h}/{bge_t} = {bge_p:.1f}% | {rr_h}/{rr_t} = {rr_p:.1f}% |")

    return r, bge_results, rerank_results


def phase2(gold_dict, edge_qs, rerank_results):
    print(f"\n=== Phase 2: cloud gen + judge with reranked top-1 parent ===")
    out_path = os.path.join(DATA, "rag-mvp-cloud-rerank.jsonl")

    parent_src_counts = []
    parent_ref_counts = []

    with open(out_path, "w") as fout:
        for i, (gid, g) in enumerate(edge_qs):
            refs, srcs = parent_refs_topN(gold_dict, rerank_results[gid], 1)
            parent_src_counts.append(len(srcs))
            parent_ref_counts.append(len(refs))

            rec = {"id": gid, "query": g["query"], "expected": g.get("expected"),
                   "category": g.get("category"), "k": K_COARSE,
                   "n_parent_srcs": len(srcs), "n_parent_refs": len(refs),
                   "parent_src_ids": srcs, "gid_in_parent": gid in srcs}

            t0 = time.time()
            try:
                ans = gen_cloud(g["query"], refs)
                rec["genFailed"] = False
            except Exception as ex:
                ans = ""
                rec["genFailed"] = True
                rec["genError"] = str(ex)[:120]
                print(f"  [{i+1}/{len(edge_qs)}] {gid} gen FAIL: {str(ex)[:80]}", flush=True)
            rec["answer"] = ans
            rec["latencyMs"] = int((time.time() - t0) * 1000)

            if ans:
                try:
                    rec["verdict"] = judge(g["query"], ans, g.get("referencePoints") or [])
                except Exception as ex:
                    rec["verdict"] = None
                    rec["judgeError"] = str(ex)[:120]
            else:
                rec["verdict"] = None
            rec["good"] = isgood(rec.get("verdict"))

            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fout.flush()
            gd = "G" if rec.get("good") else "."
            status = "FIX" if gid in RETRIEVAL_FAILURE_IDS and rec.get("good") else ""
            suffix = f" {status}" if status else ""
            print(f"  [{i+1}/{len(edge_qs)}] {gid} {gd} {rec['latencyMs']}ms "
                  f"(refs={len(refs)}, gid_in={'Y' if rec['gid_in_parent'] else 'N'}){suffix}", flush=True)
            time.sleep(0.2)

    rows = [json.loads(l) for l in open(out_path) if l.strip()]
    g = sum(1 for r in rows if r.get("good"))
    avg_refs = sum(parent_ref_counts) / len(parent_ref_counts)
    fixed = sum(1 for r in rows if r["id"] in RETRIEVAL_FAILURE_IDS and r.get("good"))

    # guard
    real_pct = g / len(rows) * 100
    if real_pct > ORACLE_CLOUD_GOOD_PCT + 1:
        print(f"\n  ⚠️ GUARD: real ({real_pct:.1f}%) > oracle ({ORACLE_CLOUD_GOOD_PCT}%). 非対称の疑い。avg refs={avg_refs:.1f} vs oracle M={ORACLE_M_REF:.1f}")

    print(f"\n  result: {g}/41 = {real_pct:.1f}% good, avg refs={avg_refs:.1f}, 8件救済={fixed}/8")
    return g, real_pct, avg_refs, fixed, rows


def write_report(phase1_r, bge_results, rerank_results, p2_data, elapsed):
    md = []
    md.append("# 30: reranker 導入で検索精度を上げられるか")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 背景")
    md.append("")
    md.append("- out/29: 対称条件(N=1)で cloud real 46.3%、top-1 gid 含有率 65.9%")
    md.append("- 律速 = bge-m3 cosine の順位精度。自質問 chunk が他質問 chunk に上位を奪われる")
    md.append("- 本レポート: Workers AI bge-reranker-base で順位を矯正し、指標改善を検証")
    md.append("")
    md.append("## 構成")
    md.append("")
    md.append(f"- 粗選: bge-m3 cosine top-{K_COARSE} (embed cache 流用)")
    md.append("- rerank: `@cf/baai/bge-reranker-base` (Workers AI, GPU)")
    md.append(f"- cloud: {CLOUD_MODEL} (OpenCode)")
    md.append(f"- judge: {JUDGE_MODEL} (OpenRouter, temp=0, 全ref統一)")
    md.append(f"- oracle 基準: `rejudge-out26-verdicts.json` oracle_cloud ({ORACLE_CLOUD_GOOD_PCT}%)")
    md.append("")

    md.append("## Phase 1: 検索指標比較（生成不要）")
    md.append("")
    md.append("| 指標 | bge-m3 cosine | reranker (bge-reranker-base) | 改善 |")
    md.append("|---|---|---|---|")
    for N in NS:
        bge_h, bge_t, bge_p = phase1_r["bge"][f"gid@{N}"]
        rr_h, rr_t, rr_p = phase1_r["rerank"][f"gid@{N}"]
        delta = rr_p - bge_p
        md.append(f"| top-{N} gid 含有率 | {bge_h}/{bge_t} = {bge_p:.1f}% | {rr_h}/{rr_t} = {rr_p:.1f}% | {delta:+.1f}pt |")
    md.append("")

    key_delta = phase1_r["rerank"]["gid@1"][2] - phase1_r["bge"]["gid@1"][2]
    if key_delta > 5:
        md.append(f"### 判定: **reranker 有効** (top-1 gid 率 {key_delta:+.1f}pt)")
        md.append("")
    elif key_delta > 0:
        md.append(f"### 判定: reranker 微弱改善 (top-1 gid 率 {key_delta:+.1f}pt)。chunk粒度変更と併用を検討")
        md.append("")
    else:
        md.append(f"### 判定: **reranker 無効** (top-1 gid 率 {key_delta:+.1f}pt)。順位矯正では改善せず。")
        md.append(f"- → chunk粒度変更（1chunk粒度→質問単位/意味単位結合）が必要。embed再計算は避けられない。")
        md.append("")

    if p2_data:
        g, real_pct, avg_refs, fixed, rows = p2_data
        md.append("## Phase 2: cloud 再生成（rerank 後 top-1 親文書）")
        md.append("")
        md.append(f"- cloud good: {g}/41 = {real_pct:.1f}%")
        md.append(f"- avg 生成入力: {avg_refs:.1f} refs (oracle M={ORACLE_M_REF:.1f})")
        sym = "✅ 対称" if abs(avg_refs - ORACLE_M_REF) < 2 else "⚠️ 要確認"
        md.append(f"- 対称性: {sym}")
        md.append(f"- 8件救済: {fixed}/8")
        md.append("")

        # 2x2
        rejudge = json.load(open(os.path.join(DATA, "rejudge-out26-verdicts.json")))
        ocloud = rejudge["oracle_cloud"]
        rd = {r["id"]: r for r in rows}
        ids = sorted(set(ocloud) & set(rd))
        both = ret = odd = rea = 0
        for gid in ids:
            og = isgood(ocloud[gid])
            rg = isgood(rd[gid].get("verdict") or rd[gid])
            if og and rg: both += 1
            elif og and not rg: ret += 1
            elif not og and rg: odd += 1
            else: rea += 1

        md.append("### 2×2: reranker vs oracle")
        md.append("")
        md.append("| | real good | real bad |")
        md.append("|---|---|---|")
        md.append(f"| **Oracle good** | {both} (both ok) | {ret} (retrieval failure) |")
        md.append(f"| **Oracle bad** | {odd} (rare) | {rea} (reasoning failure) |")
        md.append("")
        md.append(f"- oracle good: {both+ret}/41 = {(both+ret)/41*100:.1f}%")
        md.append(f"- real good: {both+odd}/41 = {(both+odd)/41*100:.1f}%")
        md.append(f"- retrieval loss: {(both+ret)/41*100:.1f}% → {(both+odd)/41*100:.1f}% (delta={(both+odd-both-ret)/41*100:+.1f}pts)")
        md.append(f"- retrieval failure: {ret}/41 = {ret/41*100:.1f}%")
        md.append(f"- reasoning failure: {rea}/41 = {rea/41*100:.1f}%")
        md.append(f"- odd: {odd}/41 = {odd/41*100:.1f}%")
        md.append("")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)


def main():
    t0 = time.time()
    print(f"=== reranker eval (out/30) Workers AI ===")
    print(f"coarse k={K_COARSE}, phase2={'ON' if DO_PHASE2 else 'OFF'}")

    gold_dict = load_gold()
    corpus = build_corpus(gold_dict)
    corpus_embeds = load_corpus_embeds()
    edge_qs = [(gid, g) for gid, g in gold_dict.items()
               if g.get("expected") == "edge" and g.get("referencePoints")]

    phase1_r, bge_results, rerank_results = phase1(gold_dict, corpus, corpus_embeds, edge_qs)

    p2_data = None
    if DO_PHASE2:
        key_delta = phase1_r["rerank"]["gid@1"][2] - phase1_r["bge"]["gid@1"][2]
        if key_delta > 5:
            print(f"\ntop-1 gid 率が {key_delta:.1f}pt 改善。Phase 2 に進む。")
            p2_data = phase2(gold_dict, edge_qs, rerank_results)
        else:
            print(f"\ntop-1 gid 率改善は {key_delta:.1f}pt。Phase 2 をスキップ。")

    elapsed = time.time() - t0
    write_report(phase1_r, bge_results, rerank_results, p2_data, elapsed)
    print(f"\n[DONE] elapsed={elapsed:.0f}s")


if __name__ == "__main__":
    main()
