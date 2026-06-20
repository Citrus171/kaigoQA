#!/usr/bin/env python3
"""out/31: chunk 粒度変更（1ref=1chunk → 1質問=1chunk）で検索精度を上げられるか検証

Phase 1（生成不要）: 新 corpus(120 chunks) で top-1 gid 率を旧(573 chunks, 65.9%)と比較
Phase 2（改善時のみ）: cloud 再生成 → 全ref judge → 2×2
"""
import json, os, time, math, re as _re, sys
import requests

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
EMBED_URL    = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACC}/ai/run/@cf/baai/bge-m3"

OPENCODE_KEY = os.environ["OPENCODE_API_KEY"]
OPENCODE_URL = "https://opencode.ai/zen/go/v1/chat/completions"
CLOUD_MODEL  = os.environ.get("OPENCODE_MODEL", "deepseek-v4-flash")

ORK          = os.environ["OPENROUTER_API_KEY"]
JUDGE_MODEL  = os.environ.get("JUDGE_MODEL", "openai/gpt-4o")
JUDGE_URL    = "https://openrouter.ai/api/v1/chat/completions"

GOLD_PATH    = os.path.join(DATA, "routing-gold-a.jsonl")
NEW_CACHE    = os.path.join(DATA, "rag-corpus-embeddings-qlevel.json")
OLD_CACHE    = os.path.join(DATA, "rag-corpus-embeddings.json")
RESULT_MD    = os.path.join(OUT, "31-chunk-granularity.md")

RETRIEVAL_FAILURE_IDS = [
    "gold-A-006", "gold-A-013", "gold-A-014", "gold-A-027",
    "gold-A-030", "gold-A-038", "gold-A-039", "gold-A-042",
]

ORACLE_CLOUD_GOOD_PCT = 61.0
OLD_TOP1_GID_PCT = 65.9
OLD_TOP3_GID_PCT = 92.7

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


def build_qlevel_corpus(gold_dict):
    """1質問=1chunk。全 referencePoints を連結。"""
    corpus = []
    for gid, g in gold_dict.items():
        refs = g.get("referencePoints") or []
        if refs:
            text = "\n".join(refs)
            corpus.append({"src_id": gid, "text": text})
    return corpus


def embed_corpus_cf(corpus, cache_path):
    """Workers AI bge-m3 で batch embed。キャッシュあれば読む。"""
    if os.path.exists(cache_path):
        print(f"[embed] cache hit: {cache_path}")
        return json.load(open(cache_path))["embeddings"]

    texts = [c["text"] for c in corpus]
    total = len(texts)
    print(f"[embed] Workers AI bge-m3: {total} chunks ...")
    t0 = time.time()

    BATCH = 100
    all_embeds = []
    for i in range(0, total, BATCH):
        batch = texts[i:i + BATCH]
        resp = requests.post(EMBED_URL,
                             headers={"Authorization": f"Bearer {CF_TOK}"},
                             json={"text": batch},
                             timeout=120)
        resp.raise_for_status()
        body = resp.json()
        if not body.get("success"):
            raise RuntimeError(f"embed error: {body.get('errors')}")
        embeds = body["result"]["data"]
        all_embeds.extend(embeds)
        elapsed = time.time() - t0
        print(f"  {min(i + BATCH, total)}/{total} ({elapsed:.0f}s)")

    json.dump({"embeddings": all_embeds}, open(cache_path, "w"), ensure_ascii=False)
    print(f"[embed] saved: {cache_path} ({time.time() - t0:.0f}s)")
    return all_embeds


def embed_query_cf(text):
    """Workers AI bge-m3 で単一クエリ embed"""
    resp = requests.post(EMBED_URL,
                         headers={"Authorization": f"Bearer {CF_TOK}"},
                         json={"text": [text]},
                         timeout=60)
    resp.raise_for_status()
    return resp.json()["result"]["data"][0]


def search_top(query, corpus, corpus_embeds, k):
    q_emb = embed_query_cf(query)
    scores = [(i, cos(q_emb, ce)) for i, ce in enumerate(corpus_embeds)]
    scores.sort(key=lambda x: -x[1])
    return [(corpus[si]["src_id"], corpus[si]["text"], sc) for si, sc in scores[:k]]


def gid_rate(edge_qs, corpus, corpus_embeds, N):
    hits = 0
    for gid, g in edge_qs:
        top = search_top(g["query"], corpus, corpus_embeds, N)
        srcs = [s for s, _, _ in top]
        if gid in srcs[:N]:
            hits += 1
    return hits, len(edge_qs)


def phase1(gold_dict, edge_qs):
    print(f"\n=== Phase 1: q-level corpus (120 chunks) vs old (573 chunks) ===")

    # build old corpus + load embed cache for old comparison
    old_corpus = []
    for g in gold_dict.values():
        for pt in (g.get("referencePoints") or []):
            old_corpus.append({"src_id": g["id"], "text": pt})
    old_embeds = json.load(open(OLD_CACHE))["embeddings"]
    old_total = len(old_corpus)

    new_corpus = build_qlevel_corpus(gold_dict)
    new_total = len(new_corpus)
    new_embeds = embed_corpus_cf(new_corpus, NEW_CACHE)

    print(f"\nold corpus: {old_total} chunks (1ref=1chunk)")
    print(f"new corpus: {new_total} chunks (1question=1chunk, refs concatenated)")

    print("\n| 指標 | old (573 chunks) | new (120 chunks) | 改善 |")
    print("|---|---|---|---|")

    results = {"old": {}, "new": {}}
    for N in [1, 3]:
        # old
        oh, ot = gid_rate(edge_qs, old_corpus, old_embeds, N)
        results["old"][N] = (oh, ot, oh / ot * 100)
        # new
        nh, nt = gid_rate(edge_qs, new_corpus, new_embeds, N)
        results["new"][N] = (nh, nt, nh / nt * 100)
        delta = results["new"][N][2] - results["old"][N][2]
        print(f"| top-{N} gid 含有率 | {oh}/{ot} = {oh/ot*100:.1f}% | {nh}/{nt} = {nh/nt*100:.1f}% | {delta:+.1f}pt |")

    return results, new_corpus, new_embeds


def phase2(gold_dict, edge_qs, corpus, corpus_embeds):
    print(f"\n=== Phase 2: cloud gen + judge (q-level, top-1 chunk) ===")
    out_path = os.path.join(DATA, "rag-mvp-cloud-qlevel.jsonl")

    ref_counts = []
    with open(out_path, "w") as fout:
        for i, (gid, g) in enumerate(edge_qs):
            top = search_top(g["query"], corpus, corpus_embeds, 1)
            src_id = top[0][0] if top else ""
            chunk_text = top[0][1] if top else ""
            gid_in_top = (src_id == gid)
            # chunk=質問単位なので、引けた chunk がそのまま全ref
            ref_lines = chunk_text.split("\n") if chunk_text else []
            n_refs = len(ref_lines)
            ref_counts.append(n_refs)

            rec = {"id": gid, "query": g["query"], "expected": g.get("expected"),
                   "category": g.get("category"), "top1_src_id": src_id,
                   "n_refs": n_refs, "gid_in_top1": gid_in_top}

            t0 = time.time()
            try:
                ans = gen_cloud(g["query"], ref_lines)
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
                  f"(top1={src_id}, refs={n_refs}, hit={'Y' if gid_in_top else 'N'}){suffix}", flush=True)
            time.sleep(0.2)

    rows = [json.loads(l) for l in open(out_path) if l.strip()]
    g = sum(1 for r in rows if r.get("good"))
    avg_refs = sum(ref_counts) / len(ref_counts) if ref_counts else 0
    fixed = sum(1 for r in rows if r["id"] in RETRIEVAL_FAILURE_IDS and r.get("good"))

    real_pct = g / len(rows) * 100
    if real_pct > ORACLE_CLOUD_GOOD_PCT + 1:
        print(f"\n  ⚠️ GUARD: real ({real_pct:.1f}%) > oracle ({ORACLE_CLOUD_GOOD_PCT}%). avg refs={avg_refs:.1f} vs oracle M≈4.9")

    print(f"\n  result: {g}/41 = {real_pct:.1f}% good, avg refs={avg_refs:.1f}, 8件救済={fixed}/8")
    return g, real_pct, avg_refs, fixed, rows


def write_report(phase1_r, p2_data, elapsed):
    md = []
    md.append("# 31: chunk 粒度変更（1ref=1chunk → 1質問=1chunk）で検索精度を上げられるか")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 背景")
    md.append("")
    md.append("- retrieval 打ち手の結果: k拡大=頭打ち / parent-document=対称で改善ゼロ(out/29) / reranker=−12.2pt悪化(out/30)")
    md.append("- 仮説: 1ref=1chunk が細かすぎる → 同一質問の chunk が cosine 空間で離散 → 他質問 chunk に上位を奪われる")
    md.append("- 本レポート: 1質問の全refを連結した120 chunk corpus で、top-1 gid 率が 65.9% から改善するか")
    md.append("")
    md.append("## 構成")
    md.append("")
    md.append("- 旧 corpus: 573 chunks (1referencePoint=1chunk, 120質問の全ref)")
    md.append("- 新 corpus: 120 chunks (1質問の全referencePointsを連結した1chunk, 1:1)")
    md.append("- embed: `@cf/baai/bge-m3` (Workers AI, GPU, dim=1024)")
    md.append(f"- cloud: {CLOUD_MODEL} (OpenCode)")
    md.append(f"- judge: {JUDGE_MODEL} (OpenRouter, temp=0, 全ref統一)")
    md.append(f"- oracle 基準: `rejudge-out26-verdicts.json` oracle_cloud ({ORACLE_CLOUD_GOOD_PCT}%)")
    md.append("")

    md.append("## Phase 1: 検索指標比較（生成不要）")
    md.append("")
    md.append("| 指標 | old (573 chunks, 1ref=1chunk) | new (120 chunks, 1質問=1chunk) | 改善 |")
    md.append("|---|---|---|---|")
    for N in [1, 3]:
        oh, ot, op = phase1_r["old"][N]
        nh, nt, np = phase1_r["new"][N]
        delta = np - op
        md.append(f"| top-{N} gid 含有率 | {oh}/{ot} = {op:.1f}% | {nh}/{nt} = {np:.1f}% | {delta:+.1f}pt |")
    md.append("")

    delta1 = phase1_r["new"][1][2] - phase1_r["old"][1][2]
    if delta1 > 5:
        md.append(f"### 判定: **粒度変更は有効** (top-1 gid 率 {delta1:+.1f}pt)")
    elif delta1 > 0:
        md.append(f"### 判定: 粒度変更は微弱改善 (top-1 gid 率 {delta1:+.1f}pt)")
    else:
        md.append(f"### 判定: **粒度変更は無効/逆効果** (top-1 gid 率 {delta1:+.1f}pt)")
        md.append("- 検索の限界は粒度でなく embedding やクエリ表現の問題。これで retrieval 系の打ち手は出尽くし。")
        md.append("- → 次の一手は generation 改善（reasoning failure 26.8%）に軸足を移す")
    md.append("")

    if p2_data:
        g, real_pct, avg_refs, fixed, rows = p2_data
        md.append("## Phase 2: cloud 再生成（top-1 chunk）")
        md.append("")
        md.append(f"- cloud good: {g}/41 = {real_pct:.1f}%")
        md.append(f"- avg 生成入力: {avg_refs:.1f} refs/chunk (oracle M≈4.9)")
        sym = "✅ 対称" if abs(avg_refs - 4.9) < 2 else "⚠️ 要確認"
        md.append(f"- 対称性: {sym}")
        md.append(f"- 8件救済: {fixed}/8")
        md.append("")

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

        n = len(ids)
        md.append("### 2×2: q-level vs oracle")
        md.append("")
        md.append("| | real good | real bad |")
        md.append("|---|---|---|")
        md.append(f"| **Oracle good** | {both} (both ok) | {ret} (retrieval failure) |")
        md.append(f"| **Oracle bad** | {odd} (rare) | {rea} (reasoning failure) |")
        md.append("")
        md.append(f"- oracle good: {both+ret}/{n} = {(both+ret)/n*100:.1f}%")
        md.append(f"- real good: {both+odd}/{n} = {(both+odd)/n*100:.1f}%")
        md.append(f"- retrieval loss: {(both+ret)/n*100:.1f}% → {(both+odd)/n*100:.1f}% (delta={(both+odd-both-ret)/n*100:+.1f}pts)")
        md.append(f"- retrieval failure: {ret}/{n} = {ret/n*100:.1f}%")
        md.append(f"- reasoning failure: {rea}/{n} = {rea/n*100:.1f}%")
        md.append("")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)


def main():
    t0 = time.time()
    print(f"=== chunk granularity: q-level (out/31) ===")
    print(f"phase2={'ON' if DO_PHASE2 else 'OFF'}")

    gold_dict = load_gold()
    edge_qs = [(gid, g) for gid, g in gold_dict.items()
               if g.get("expected") == "edge" and g.get("referencePoints")]

    phase1_r, new_corpus, new_embeds = phase1(gold_dict, edge_qs)

    p2_data = None
    if DO_PHASE2:
        delta1 = phase1_r["new"][1][2] - phase1_r["old"][1][2]
        if delta1 > 5:
            print(f"\ntop-1 gid 率が {delta1:.1f}pt 改善。Phase 2 に進む。")
            p2_data = phase2(gold_dict, edge_qs, new_corpus, new_embeds)
        else:
            print(f"\ntop-1 gid 率改善は {delta1:.1f}pt。Phase 2 をスキップ。")

    elapsed = time.time() - t0
    write_report(phase1_r, p2_data, elapsed)
    print(f"\n[DONE] elapsed={elapsed:.0f}s")


if __name__ == "__main__":
    main()
