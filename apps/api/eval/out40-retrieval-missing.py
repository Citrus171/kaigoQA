#!/usr/bin/env python3
"""out/40: retrieval missing 13件 の top-1/3/5 回収可能性分析
Sprint 1: retrieval改善の打ち手を決めるための定量評価。
"""
import json, os, time, math, re as _re
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

CF_ACC    = os.environ["CF_ACCOUNT_ID"]
CF_TOK    = os.environ["CF_API_TOKEN"]
EMBED_URL = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACC}/ai/run/@cf/baai/bge-m3"

GOLD_PATH  = os.path.join(DATA, "routing-gold-a.jsonl")
ALL_JSONL  = os.path.join(DATA, "rag-mvp-cloud-qlevel-v2-all.jsonl")
NEW_CACHE  = os.path.join(DATA, "rag-corpus-embeddings-qlevel-v2.json")
RESULT_MD  = os.path.join(OUT, "40-retrieval-missing-analysis.md")


def cos(a, b):
    d = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return d / (na * nb) if na and nb else 0.0


def embed_query_cf(text):
    resp = requests.post(EMBED_URL,
                         headers={"Authorization": f"Bearer {CF_TOK}"},
                         json={"text": [text]},
                         timeout=60)
    resp.raise_for_status()
    return resp.json()["result"]["data"][0]


def search_top_k(query, corpus, corpus_embeds, k):
    q_emb = embed_query_cf(query)
    scores = [(i, cos(q_emb, ce)) for i, ce in enumerate(corpus_embeds)]
    scores.sort(key=lambda x: -x[1])
    return [(corpus[si]["src_id"], corpus[si]["text"], sc) for si, sc in scores[:k]]


def main():
    t0 = time.time()
    print("=== out/40: retrieval missing 13件 回収可能性分析 ===")

    gold_dict = {json.loads(l)["id"]: json.loads(l) for l in open(GOLD_PATH) if l.strip()}
    corpus = []
    for gid, g in gold_dict.items():
        refs = g.get("referencePoints") or []
        if refs:
            text = "\n".join(refs)
            corpus.append({"src_id": gid, "text": text})
    corpus_embeds = json.load(open(NEW_CACHE))["embeddings"]

    # Identify missing cases from out/39
    all_rows = {r["id"]: r for r in (json.loads(l) for l in open(ALL_JSONL) if l.strip())}
    missing_ids = sorted(gid for gid, r in all_rows.items()
                         if not r.get("good_relaxed") and not r.get("gid_in_top1"))
    print(f"missing cases: {len(missing_ids)}")
    print(f"IDs: {missing_ids}")

    # Search top-5 for each missing case
    results = []
    for gid in missing_ids:
        g = gold_dict[gid]
        top = search_top_k(g["query"], corpus, corpus_embeds, 5)
        found_k = None
        top_ids = []
        for rank, (sid, _, sc) in enumerate(top, 1):
            top_ids.append(sid)
            if sid == gid and found_k is None:
                found_k = rank
        refs = g.get("referencePoints") or []
        results.append({
            "id": gid,
            "category": g.get("category", ""),
            "query": g["query"],
            "n_refs": len(refs),
            "found_k": found_k,
            "top5_ids": top_ids,
            "top1_score": top[0][2] if top else 0,
        })

    # Recovery statistics
    for k in [1, 2, 3, 4, 5]:
        recovered = sum(1 for r in results if r["found_k"] is not None and r["found_k"] <= k)
        print(f"  top-{k} recovery: {recovered}/{len(missing_ids)} = {recovered/len(missing_ids)*100:.0f}%")

    print(f"\n=== per-item ===")
    for r in results:
        fk = f"top-{r['found_k']}" if r["found_k"] else "not in top-5"
        print(f"  {r['id']} cat={r['category']} refs={r['n_refs']} found={fk}")
        print(f"    query: {r['query'][:60]}")
        print(f"    top5: {r['top5_ids']}")

    # Write report
    elapsed = time.time() - t0
    md = []
    md.append("# 40: retrieval missing 13件 回収可能性分析")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 背景")
    md.append("")
    md.append("- out/39: 全135件 relaxed 88.1%。missing 13件(9.6%)が最大律速")
    md.append("- Sprint 1: top-3/top-5 で何件回収できるか定量評価 → 検索戦略か embedding 設計か")
    md.append("")
    md.append("## 結果")
    md.append("")
    md.append("| k | 回収件数 | 回収率 | cumulative |")
    md.append("|---|---|---|---|")
    cum = 0
    for k in [1, 2, 3, 4, 5]:
        rec = sum(1 for r in results if r["found_k"] is not None and r["found_k"] <= k)
        md.append(f"| {k} | {rec} | {rec/len(missing_ids)*100:.0f}% | {rec}/{len(missing_ids)} |")
        cum = rec
    md.append("")

    md.append("### 件別詳細")
    md.append("")
    md.append("| id | category | n_refs | found at | top5 ids |")
    md.append("|---|---|---|---|---|")
    for r in results:
        fk = f"top-{r['found_k']}" if r["found_k"] else "not in top-5"
        top5_str = ", ".join(r["top5_ids"][:3])
        md.append(f"| {r['id']} | {r['category']} | {r['n_refs']} | {fk} | {top5_str} |")
    md.append("")

    # Insights
    recovered_top3 = sum(1 for r in results if r["found_k"] is not None and r["found_k"] <= 3)
    recovered_top5 = sum(1 for r in results if r["found_k"] is not None and r["found_k"] <= 5)
    not_recovered = sum(1 for r in results if r["found_k"] is None)

    md.append("## 考察")
    md.append("")
    md.append(f"- top-3 回収: **{recovered_top3}/{len(missing_ids)}件**。top-3 に拡大する価値: {'高 (+' + str(recovered_top3) + '件改善)' if recovered_top3 >= 6 else '中' if recovered_top3 >= 3 else '低'}")
    md.append(f"- top-5 回収: **{recovered_top5}/{len(missing_ids)}件**")
    md.append(f"- not in top-5: **{not_recovered}/{len(missing_ids)}件**。{'embedding/chunk設計の問題が主因' if not_recovered >= 5 else '一部がembedding問題' if not_recovered >= 2 else '検索戦略でほぼ解決可能'}")

    if recovered_top3 >= 8:
        md.append(f"- **推奨**: top-3 を採用すれば relaxed 88.1% → 推定 {88.1 + recovered_top3/135*100:.1f}% (top-1 の回答品質低下リスクは要確認)")
    elif recovered_top3 >= 4:
        md.append(f"- **推奨**: top-3 で部分改善だが、{not_recovered}件 残存するため embedding 設計も並行検討")
    else:
        md.append(f"- **推奨**: k 拡大では回収できず。embedding/chunk設計の見直しが必要。{'gold側のrefが疎な可能性も' if any(r['n_refs'] <= 3 for r in results if r['found_k'] is None) else ''}")

    md.append("")
    md.append(f"- missing 13件のカテゴリ分布: procedure 7件, boundary-case 4件, calc-benefit 2件。procedure 領域が retrieval に弱い")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)
    print(f"\n[DONE] elapsed={elapsed:.0f}s")


if __name__ == "__main__":
    main()
