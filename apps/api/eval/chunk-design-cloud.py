#!/usr/bin/env python3
"""out/28: cloud retrieval failure を削るチャンク設計見直し

診断 + アプローチC（parent-document retrieval）で cloud 実RAG(k=20)の retrieval failure 8件を検証。

usage:
  python3 chunk-design-cloud.py              # 診断 + C方式生成 + 判定 + 2x2
  python3 chunk-design-cloud.py --diagnose   # 診断のみ（生成不要）
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
EDGE_MODEL   = "@cf/google/gemma-4-26b-a4b-it"
CF_API       = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACC}/ai/run/{EDGE_MODEL}"

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
RESULT_MD    = os.path.join(OUT, "28-cloud-chunk-design.md")

RETRIEVAL_FAILURE_IDS = [
    "gold-A-006", "gold-A-013", "gold-A-014", "gold-A-027",
    "gold-A-030", "gold-A-038", "gold-A-039", "gold-A-042",
]
K = 20

DIAGNOSE_ONLY = "--diagnose" in sys.argv

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


def embed_query(text):
    r = requests.post(OLLAMA_URL, json={"model": EMBED_MODEL, "input": [text]}, timeout=600)
    r.raise_for_status()
    return r.json()["embeddings"][0]


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


def build_corpus(gold_dict):
    corpus = []
    for g in gold_dict.values():
        for pt in (g.get("referencePoints") or []):
            corpus.append({"src_id": g["id"], "text": pt})
    return corpus


def load_corpus_embeds():
    print(f"[embed] cache hit: {EMBED_CACHE}")
    return json.load(open(EMBED_CACHE))["embeddings"]


def retrieve_top(query, corpus, corpus_embeds, k):
    q_emb = embed_query(query)
    scores = [(i, cos(q_emb, ce)) for i, ce in enumerate(corpus_embeds)]
    scores.sort(key=lambda x: -x[1])
    return [(corpus[si]["src_id"], corpus[si]["text"], sc) for si, sc in scores[:k]]


def diagnose(gold_dict, corpus, corpus_embeds):
    print("\n=== 診断: retrieval failure 8件 ===")
    entries = []
    for gid in RETRIEVAL_FAILURE_IDS:
        g = gold_dict[gid]
        refs = g["referencePoints"]
        M = len(refs)
        top = retrieve_top(g["query"], corpus, corpus_embeds, K)
        top_srcs = [s for s, _, _ in top]
        hit_i = top_srcs.count(gid)

        ref_in_top = []
        ref_not_in_top = []
        for i, pt in enumerate(refs):
            found = any(s == gid and t == pt for s, t, _ in top)
            if found:
                ref_in_top.append((i, pt[:60]))
            else:
                ref_not_in_top.append((i, pt[:60]))

        other_counts = Counter(s for s in top_srcs if s != gid)
        top_others = other_counts.most_common(5)

        print(f"\n## {gid} (M={M}, coverage={hit_i}/{M}={hit_i/M*100:.0f}%, full={'Y' if hit_i==M else 'N'})")
        print(f"  query: {g['query'][:80]}")
        print(f"  refs in top-{K} ({len(ref_in_top)}/{M}):")
        for idx, pt in ref_in_top:
            print(f"    [{idx}] {pt}")
        print(f"  refs NOT in top-{K} ({len(ref_not_in_top)}/{M}):")
        for idx, pt in ref_not_in_top:
            print(f"    [{idx}] {pt}")
        print(f"  top-{K} other src_ids (count):")
        for sid, cnt in top_others:
            print(f"    {sid} x{cnt}: {gold_dict[sid]['query'][:60]}")

        entries.append({
            "gid": gid, "M": M, "hit_i": hit_i,
            "top_srcs": top_srcs, "other_counts": other_counts,
            "ref_in_top": [(idx, refs[idx]) for idx, _ in ref_in_top],
            "ref_not_in_top": [(idx, refs[idx]) for idx, _ in ref_not_in_top],
            "query": g["query"],
            "gold_for_other": gold_dict,
        })
    return entries


def parent_document_refs(gold_dict, top_results):
    """top-k の検索結果から、出現した全 src_id の「親文書」(全referencePoints)を収集"""
    unique_srcs = list(dict.fromkeys([s for s, _, _ in top_results]))  # 順序保持・重複除去
    refs = []
    for src_id in unique_srcs:
        for pt in (gold_dict.get(src_id, {}).get("referencePoints") or []):
            if pt not in refs:  # 重複テキストを除去
                refs.append(pt)
    return refs, unique_srcs


def run_approach_c(gold_dict, corpus, corpus_embeds, edge_qs):
    print(f"\n=== アプローチC: parent-document retrieval (k={K}) ===")
    out_path = os.path.join(DATA, "rag-mvp-cloud-chunkC.jsonl")

    with open(out_path, "w") as fout:
        for i, (gid, g) in enumerate(edge_qs):
            top = retrieve_top(g["query"], corpus, corpus_embeds, K)
            parent_refs, unique_srcs = parent_document_refs(gold_dict, top)

            rec = {"id": gid, "query": g["query"], "expected": g.get("expected"),
                   "category": g.get("category"), "k": K,
                   "n_parent_srcs": len(unique_srcs),
                   "n_parent_refs": len(parent_refs),
                   "parent_src_ids": unique_srcs}

            t0 = time.time()
            try:
                ans = gen_cloud(g["query"], parent_refs)
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
                  f"(parent_srcs={len(unique_srcs)}, refs={len(parent_refs)}){suffix}", flush=True)
            time.sleep(0.2)

    rows = [json.loads(l) for l in open(out_path) if l.strip()]
    g = sum(1 for r in rows if r.get("good"))
    fixed = sum(1 for r in rows if r["id"] in RETRIEVAL_FAILURE_IDS and r.get("good"))
    print(f"\n  result: {g}/{len(rows)} = {g/len(rows)*100:.1f}% good")
    print(f"  8件救済: {fixed}/8")
    for r in rows:
        if r["id"] in RETRIEVAL_FAILURE_IDS:
            print(f"    {r['id']}: {'G' if r.get('good') else '.'} (parent_srcs={r['n_parent_srcs']}, refs={r['n_parent_refs']})")
    return out_path


def analysis(gold_dict):
    print("\n=== 2x2 analysis (approach C) ===")

    rejudge = json.load(open(os.path.join(DATA, "rejudge-out26-verdicts.json")))
    oracle_cloud = rejudge["oracle_cloud"]

    cloud_new = {o["id"]: o for o in
                 (json.loads(l) for l in open(os.path.join(DATA, "rag-mvp-cloud-chunkC.jsonl")) if l.strip())}

    ids = sorted(set(oracle_cloud) & set(cloud_new))
    both = ret = odd = rea = 0
    ret_ids, odd_ids = [], []
    for gid in ids:
        og = isgood(oracle_cloud[gid])
        rg = isgood(cloud_new[gid].get("verdict") or cloud_new[gid])
        if og and rg:
            both += 1
        elif og and not rg:
            ret += 1
            ret_ids.append(gid)
        elif not og and rg:
            odd += 1
            odd_ids.append(gid)
        else:
            rea += 1

    n = len(ids)
    og_n = both + ret
    rg_n = both + odd

    result = dict(n=n, both=both, ret=ret, odd=odd, rea=rea, og_n=og_n, rg_n=rg_n,
                  ret_ids=ret_ids, odd_ids=odd_ids)

    print(f"\n## 2x2: CLOUD approach C (n={n}, k={K})")
    print(f"|                | real good | real bad |")
    print(f"| Oracle good    | {both:>2} (both ok)  | {ret:>2} (retrieval failure) |")
    print(f"| Oracle bad     | {odd:>2} (rare) | {rea:>2} (reasoning failure)  |")
    print(f"- oracle good: {og_n}/{n} = {og_n/n*100:.1f}%")
    print(f"- real good  : {rg_n}/{n} = {rg_n/n*100:.1f}%")
    print(f"- retrieval loss: {og_n/n*100:.1f}% -> {rg_n/n*100:.1f}% (delta={rg_n/n*100-og_n/n*100:+.1f}pts)")
    print(f"- retrieval failure: {ret}/{n} = {ret/n*100:.1f}%  ids={ret_ids}")
    print(f"- reasoning failure: {rea}/{n} = {rea/n*100:.1f}%")
    print(f"- odd: {odd}/{n} = {odd/n*100:.1f}%  ids={odd_ids}")

    # 8件の救済状況
    rescued = [gid for gid in RETRIEVAL_FAILURE_IDS if cloud_new[gid].get("good")]
    not_rescued = [gid for gid in RETRIEVAL_FAILURE_IDS if not cloud_new[gid].get("good")]
    print(f"\n  元 retrieval failure 8件の救済: {len(rescued)}/8")
    print(f"    救済: {rescued}")
    print(f"    未救済: {not_rescued}")

    return result, rescued, not_rescued


def write_report(diag_entries, result, rescued, not_rescued, elapsed):
    md = []
    md.append("# 28: cloud retrieval failure を削るチャンク設計見直し")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 背景")
    md.append("")
    md.append("- out/27: cloud(k=20) retrieval failure = 8/41 = 19.5%")
    md.append("- 改善対象: " + ", ".join(RETRIEVAL_FAILURE_IDS))
    md.append("- アプローチC: 検索は細chunk(573)のまま、生成に親文書(質問単位の全referencePoints)を渡す")
    md.append("- full-coverage頭打ち(19.5%→22.0%)を構造的に回避する定石")
    md.append("")
    md.append("## 診断: retrieval failure 8件の個別分析")
    md.append("")

    for entry in diag_entries:
        gid = entry["gid"]
        M = entry["M"]
        hit_i = entry["hit_i"]
        top_srcs = entry["top_srcs"]
        other_counts = entry["other_counts"]
        ref_in_top = entry["ref_in_top"]
        ref_not_in_top = entry["ref_not_in_top"]
        query = entry["query"]
        gold_dict_query = entry.get("gold_for_other", {})

        md.append(f"### {gid}")
        md.append("")
        md.append(f"- M={M}, coverage@20={hit_i}/{M} ({hit_i/M*100:.0f}%), full-coverage={'Y' if hit_i==M else 'N'}")
        md.append(f"- query: {query[:100]}")
        md.append(f"- 取得 refs ({len(ref_in_top)}/{M}):")
        for idx, pt in ref_in_top:
            md.append(f"  - [{idx}] {pt}")
        md.append(f"- 未取得 refs ({len(ref_not_in_top)}/{M}):")
        for idx, pt in ref_not_in_top:
            md.append(f"  - [{idx}] {pt}")
        md.append(f"- top-{K} 他質問 (chunk数):")
        for sid, cnt in other_counts.most_common(5):
            other_q = gold_dict_query.get(sid, {}).get("query", sid)[:60] if gold_dict_query else sid
            md.append(f"  - {sid} x{cnt}: {other_q}")
        md.append("")

    md.append("## アプローチC: parent-document retrieval")
    md.append("")
    md.append(f"- 検索: fine-grained 573 chunks (現状維持・embedキャッシュ流用)")
    md.append(f"- 生成: top-{K} に出現した各 src_id の全 referencePoints（親文書）を渡す")
    md.append(f"- k={K}")
    md.append("")

    md.append("## 結果")
    md.append("")
    n = result["n"]
    og_pct = result["og_n"] / n * 100
    rg_pct = result["rg_n"] / n * 100
    md.append(f"- cloud good (approach C): {result['rg_n']}/{n} = {rg_pct:.1f}%")
    md.append(f"- retrieval failure 8件の救済: {len(rescued)}/8")
    md.append(f"  - 救済: {rescued if rescued else 'なし'}")
    md.append(f"  - 未救済: {not_rescued if not_rescued else 'なし'}")
    md.append("")

    md.append("### 2×2: CLOUD approach C vs oracle (全ref統一judge)")
    md.append("")
    md.append("| | real good | real bad |")
    md.append("|---|---|---|")
    md.append(f"| **Oracle good** | {result['both']} (both ok) | {result['ret']} (retrieval failure) |")
    md.append(f"| **Oracle bad** | {result['odd']} (rare) | {result['rea']} (reasoning failure) |")
    md.append("")
    md.append(f"- oracle good: {result['og_n']}/{n} = {og_pct:.1f}%")
    md.append(f"- real good: {result['rg_n']}/{n} = {rg_pct:.1f}%")
    md.append(f"- retrieval loss: {og_pct:.1f}% -> {rg_pct:.1f}% (delta={rg_pct-og_pct:+.1f}pts)")
    md.append(f"- retrieval failure: {result['ret']}/{n} = {result['ret']/n*100:.1f}%" + (f" ids={result['ret_ids']}" if result['ret'] else ""))
    md.append(f"- reasoning failure: {result['rea']}/{n} = {result['rea']/n*100:.1f}%")
    md.append("")

    md.append("### 比較: k=20 baseline → approach C")
    md.append("")
    md.append("| 方式 | cloud good | retrieval failure | retrieval loss |")
    md.append("|---|---|---|---|")
    md.append("| baseline (k=20, fine chunk) | 46.3% | 8/41 = 19.5% | -14.6pt |")
    md.append(f"| approach C (k=20, parent doc) | {rg_pct:.1f}% | {result['ret']}/41 = {result['ret']/41*100:.1f}% | {rg_pct-og_pct:+.1f}pt |")
    md.append("")

    md.append("## 考察")
    md.append("")
    rescued_n = len(rescued)
    if rescued_n >= 6:
        md.append(f"- **アプローチCは有効**: 8件中 {rescued_n} 件救済。parent-document retrieval により全要点を渡せるようになり、retrieval failure が削減された。")
    elif rescued_n >= 3:
        md.append(f"- アプローチCは部分有効: 8件中 {rescued_n} 件救済。残り {8-rescued_n} 件は retrieval で src_id 自体が引けていない（1つも chunk が top-{K} に入らない）か、generation が情報を使いこなせていない。")
    else:
        md.append(f"- アプローチCの効果は限定的: 8件中 {rescued_n} 件のみ救済。retrieval failure の原因は親文書の不在（src_id全滅）か generation の情報活用不足。")
    md.append(f"- 残る retrieval failure: {result['ret']}/{n} = {result['ret']/n*100:.1f}%")
    md.append(f"- 残る reasoning failure: {result['rea']}/{n} = {result['rea']/n*100:.1f}%")
    if result['rea'] > result['ret']:
        md.append(f"- **generation(reasoning failure) が依然として主要律速**（{result['rea']}/{n}）。次の一手は generation 改善。")
    else:
        md.append(f"- **retrieval が依然として律速**。次の一手は検索精度向上（embedding改善/reranker/chunk粒度）。")
    md.append("")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)


def main():
    t0 = time.time()
    print(f"=== cloud chunk-design: approach C (out/28) ===")
    print(f"k={K}, targets={RETRIEVAL_FAILURE_IDS}")

    gold_dict = load_gold()
    corpus = build_corpus(gold_dict)
    corpus_embeds = load_corpus_embeds()
    edge_qs = [(gid, g) for gid, g in gold_dict.items()
               if g.get("expected") == "edge" and g.get("referencePoints")]

    # Step 1: diagnosis
    diag_entries = diagnose(gold_dict, corpus, corpus_embeds)

    if DIAGNOSE_ONLY:
        print("\n[DONE diagnosis only]")
        return

    # Step 2: approach C generation + judge
    out_path = run_approach_c(gold_dict, corpus, corpus_embeds, edge_qs)

    # Step 3: analysis
    result, rescued, not_rescued = analysis(gold_dict)

    # Step 4: report
    elapsed = time.time() - t0
    write_report(diag_entries, result, rescued, not_rescued, elapsed)

    print(f"\n[DONE] elapsed={elapsed:.0f}s")


if __name__ == "__main__":
    main()
