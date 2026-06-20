#!/usr/bin/env python3
"""out/29: approach C を公正に再実装。parent-document retrieval を top-N unique src_id 制限。

N=1,2,3 で比較。生成入力規模を oracle(M≈4.9) と同オーダーに揃える。
oracle 対称性担保: real good > 61.0% になったら停止。
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
RESULT_MD    = os.path.join(OUT, "29-parent-doc-fix.md")

RETRIEVAL_FAILURE_IDS = [
    "gold-A-006", "gold-A-013", "gold-A-014", "gold-A-027",
    "gold-A-030", "gold-A-038", "gold-A-039", "gold-A-042",
]

K = 20
NS = [1, 2, 3]

ORACLE_CLOUD_GOOD_N = 25
ORACLE_CLOUD_GOOD_PCT = 61.0

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


def parent_doc_refs_topN(gold_dict, top_results, N):
    """top-k からスコア順に出現した unique src_id 上位 N の親文書を返す。
    Returns: (refs_list, unique_srcs_list, gid_in_topN: bool)"""
    seen = []
    unique_srcs = []
    for src, _, _ in top_results:
        if src not in seen:
            seen.append(src)
            unique_srcs.append(src)
    top_n_srcs = unique_srcs[:N]
    refs = []
    for src_id in top_n_srcs:
        for pt in (gold_dict.get(src_id, {}).get("referencePoints") or []):
            if pt not in refs:
                refs.append(pt)
    return refs, top_n_srcs


def topN_gid_hit_rate(gold_dict, edge_qs, all_top, N):
    """top-N unique src_id に質問自身(gid)が含まれる率"""
    hits = 0
    for gid, g in edge_qs:
        _, srcs = parent_doc_refs_topN(gold_dict, all_top[gid], N)
        if gid in srcs:
            hits += 1
    return hits, len(edge_qs)


def run_N(gold_dict, corpus, corpus_embeds, edge_qs, all_top, N):
    print(f"\n{'='*60}")
    print(f"=== N={N}: cloud gen + judge ===")
    print(f"{'='*60}")
    out_path = os.path.join(DATA, f"rag-mvp-cloud-parentN{N}.jsonl")

    parent_src_counts = []
    parent_ref_counts = []

    with open(out_path, "w") as fout:
        for i, (gid, g) in enumerate(edge_qs):
            parent_refs, parent_srcs = parent_doc_refs_topN(gold_dict, all_top[gid], N)
            parent_src_counts.append(len(parent_srcs))
            parent_ref_counts.append(len(parent_refs))

            rec = {"id": gid, "query": g["query"], "expected": g.get("expected"),
                   "category": g.get("category"), "k": K, "N": N,
                   "n_parent_srcs": len(parent_srcs),
                   "n_parent_refs": len(parent_refs),
                   "parent_src_ids": parent_srcs,
                   "gid_in_parent": gid in parent_srcs}

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
            hit_info = f"gid_in_parent={'Y' if rec['gid_in_parent'] else 'N'}"
            status = "FIX" if gid in RETRIEVAL_FAILURE_IDS and rec.get("good") else ""
            suffix = f" {status}" if status else ""
            print(f"  [{i+1}/{len(edge_qs)}] {gid} {gd} {rec['latencyMs']}ms "
                  f"(srcs={len(parent_srcs)}, refs={len(parent_refs)}, {hit_info}){suffix}", flush=True)
            time.sleep(0.2)

    rows = [json.loads(l) for l in open(out_path) if l.strip()]
    g = sum(1 for r in rows if r.get("good"))
    fixed = sum(1 for r in rows if r["id"] in RETRIEVAL_FAILURE_IDS and r.get("good"))
    avg_srcs = sum(parent_src_counts) / len(parent_src_counts)
    avg_refs = sum(parent_ref_counts) / len(parent_ref_counts)
    gid_hit, gid_total = topN_gid_hit_rate(gold_dict, edge_qs, all_top, N)

    print(f"\n  N={N} result: {g}/{len(rows)} = {g/len(rows)*100:.1f}% good")
    print(f"  avg parent_srcs: {avg_srcs:.1f}, avg parent_refs: {avg_refs:.1f}")
    print(f"  top-{N} gid含有率: {gid_hit}/{gid_total} = {gid_hit/gid_total*100:.1f}%")
    print(f"  8件救済: {fixed}/8")
    for r in rows:
        if r["id"] in RETRIEVAL_FAILURE_IDS:
            print(f"    {r['id']}: {'G' if r.get('good') else '.'} (gid_in_parent={'Y' if r['gid_in_parent'] else 'N'})")

    # guard: real good > oracle なら非対称を疑う
    if g / len(rows) * 100 > ORACLE_CLOUD_GOOD_PCT + 1.0:
        print(f"\n  ⚠️ GUARD: real good ({g/len(rows)*100:.1f}%) > oracle ({ORACLE_CLOUD_GOOD_PCT}%). 非対称の疑い。")

    return {
        "N": N,
        "rows": rows,
        "good": g,
        "total": len(rows),
        "good_pct": g / len(rows) * 100,
        "fixed": fixed,
        "avg_parent_srcs": avg_srcs,
        "avg_parent_refs": avg_refs,
        "gid_hit": gid_hit,
        "gid_total": gid_total,
        "gid_hit_pct": gid_hit / gid_total * 100,
        "parent_src_counts": parent_src_counts,
        "parent_ref_counts": parent_ref_counts,
    }


def analysis_for_N(cloud_dict):
    """rejudge-out26-verdicts.json の oracle_cloud と比較"""
    rejudge = json.load(open(os.path.join(DATA, "rejudge-out26-verdicts.json")))
    oracle_cloud = rejudge["oracle_cloud"]

    ids = sorted(set(oracle_cloud) & set(cloud_dict))
    both = ret = odd = rea = 0
    ret_ids, odd_ids = [], []
    for gid in ids:
        og = isgood(oracle_cloud[gid])
        rg = isgood(cloud_dict[gid].get("verdict") or cloud_dict[gid])
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

    rescued = [gid for gid in RETRIEVAL_FAILURE_IDS
               if gid in cloud_dict and cloud_dict[gid].get("good")]
    not_rescued = [gid for gid in RETRIEVAL_FAILURE_IDS
                   if gid in cloud_dict and not cloud_dict[gid].get("good")]

    return dict(n=n, both=both, ret=ret, odd=odd, rea=rea,
                og_n=og_n, rg_n=rg_n, og_pct=og_n/n*100, rg_pct=rg_n/n*100,
                ret_ids=ret_ids, odd_ids=odd_ids,
                rescued=rescued, not_rescued=not_rescued)


def write_report(all_results, elapsed):
    md = []
    md.append("# 29: approach C 公正再実装 (parent-doc top-N)")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 背景")
    md.append("")
    md.append("- out/28 の approach C は top-20 に出現した**全 src_id の親**(平均~70refs, 14.3倍oracle)を渡し、実質「大量文脈総当たり」だった")
    md.append("- その結果 real=65.9% が oracle=61.0% を超える偽の逆転（odd=8件）。生成入力規模の非対称が原因と判明")
    md.append("- 本レポート: parent-document retrieval を **top-N unique src_id の親のみ**に制限し、N=1,2,3 を比較")
    md.append(f"- oracle の生成入力: M≈4.9refs。N=1 は ~M、N=3 は ~3M で同オーダー")
    md.append("")
    md.append("## 構成")
    md.append("")
    md.append(f"- 検索: fine-grained 573 chunks (embed cache 流用, cosine top-{K})")
    md.append(f"- 生成用 refs: top-{K} から score 順の unique src_id 上位 N 個の親文書(全 referencePoints)")
    md.append(f"- cloud モデル: {CLOUD_MODEL} (OpenCode)")
    md.append(f"- judge: {JUDGE_MODEL} (OpenRouter, temp=0, 全ref統一)")
    md.append(f"- oracle 基準: `rejudge-out26-verdicts.json` oracle_cloud ({ORACLE_CLOUD_GOOD_N}/41 = {ORACLE_CLOUD_GOOD_PCT}%)")
    md.append(f"- 改善対象: " + ", ".join(RETRIEVAL_FAILURE_IDS))
    md.append("")

    md.append("## 結果サマリ")
    md.append("")
    md.append("| N | cloud good | avg parent_srcs | avg parent_refs | top-N gid含有率 | retrieval failure | 8件救済 | oracle比(61.0%) |")
    md.append("|---|---|---|---|---|---|---|---|")
    for r in all_results:
        ar = r["analysis"]
        sym = "✅ 対称" if abs(r["good_pct"] - ORACLE_CLOUD_GOOD_PCT) <= 3 else "⚠️ 非対称?"
        md.append(f"| {r['N']} | {r['good']}/41 = {r['good_pct']:.1f}% "
                  f"| {r['avg_parent_srcs']:.1f} | {r['avg_parent_refs']:.1f} "
                  f"| {r['gid_hit']}/{r['gid_total']} = {r['gid_hit_pct']:.1f}% "
                  f"| {ar['ret']}/41 = {ar['ret']/41*100:.1f}% "
                  f"| {len(ar['rescued'])}/8 "
                  f"| {sym} |")
    md.append("")
    md.append(f"- oracle 生成入力: M≈4.9 refs（自質問の全referencePoints）")
    md.append("")

    for r in all_results:
        N = r["N"]
        ar = r["analysis"]
        md.append(f"## N={N} 詳細")
        md.append("")
        md.append(f"- cloud good: {r['good']}/{r['total']} = {r['good_pct']:.1f}%")
        md.append(f"- avg parent_srcs: {r['avg_parent_srcs']:.1f}, avg parent_refs: {r['avg_parent_refs']:.1f}")
        md.append(f"- top-{N} gid含有率: {r['gid_hit']}/{r['gid_total']} = {r['gid_hit_pct']:.1f}%")
        md.append(f"- 8件救済: {len(ar['rescued'])}/8")
        if ar['rescued']:
            md.append(f"  - 救済: {ar['rescued']}")
        if ar['not_rescued']:
            md.append(f"  - 未救済: {ar['not_rescued']}")
        md.append("")

        md.append(f"### 2×2: N={N}")
        md.append("")
        md.append("| | real good | real bad |")
        md.append("|---|---|---|")
        md.append(f"| **Oracle good** | {ar['both']} (both ok) | {ar['ret']} (retrieval failure) |")
        md.append(f"| **Oracle bad** | {ar['odd']} (rare) | {ar['rea']} (reasoning failure) |")
        md.append("")
        md.append(f"- oracle good: {ar['og_n']}/41 = {ar['og_pct']:.1f}%")
        md.append(f"- real good: {ar['rg_n']}/41 = {ar['rg_pct']:.1f}%")
        md.append(f"- retrieval loss: {ar['og_pct']:.1f}% -> {ar['rg_pct']:.1f}% (delta={ar['rg_pct']-ar['og_pct']:+.1f}pts)")
        md.append(f"- retrieval failure: {ar['ret']}/41 = {ar['ret']/41*100:.1f}%" + (f" ids={ar['ret_ids']}" if ar['ret'] else ""))
        md.append(f"- reasoning failure: {ar['rea']}/41 = {ar['rea']/41*100:.1f}%")
        md.append(f"- odd: {ar['odd']}/41 = {ar['odd']/41*100:.1f}%" + (f" ids={ar['odd_ids']}" if ar['odd'] else ""))
        md.append("")

    md.append("## 比較: 全方式")
    md.append("")
    md.append("| 方式 | cloud good | retrieval failure | retrieval loss | 生成入力規模 | 対称性 |")
    md.append("|---|---|---|---|---|---|")
    md.append(f"| oracle (全ref注入) | {ORACLE_CLOUD_GOOD_N}/41 = {ORACLE_CLOUD_GOOD_PCT}% | 0% | 0pt | M≈4.9refs | 基準 |")
    md.append("| baseline k=5 | 39.0% | 29.3% | -22.0pt | top-5 chunks | ✅ |")
    md.append("| baseline k=20 | 46.3% | 19.5% | -14.6pt | top-20 chunks | ✅ |")
    md.append("| out/28 (全src親) | 65.9% | 14.6% | +4.9pt | avg 69.7refs | ⚠️ 非対称(14.3倍) |")
    for r in all_results:
        ar = r["analysis"]
        sym = "✅" if abs(r["good_pct"] - ORACLE_CLOUD_GOOD_PCT) <= 3 else "⚠️"
        md.append(f"| out/29 N={r['N']} | {r['good_pct']:.1f}% | {ar['ret']/41*100:.1f}% "
                  f"| {r['good_pct']-ORACLE_CLOUD_GOOD_PCT:+.1f}pt "
                  f"| avg {r['avg_parent_refs']:.1f}refs | {sym} |")
    md.append("")

    md.append("## 考察")
    md.append("")

    best_n = max(all_results, key=lambda r: r["good"])
    best_analysis = best_n["analysis"]

    if best_n["good_pct"] > ORACLE_CLOUD_GOOD_PCT + 1:
        md.append(f"- ⚠️ **N={best_n['N']} で real ({best_n['good_pct']:.1f}%) が oracle を超えた。** 生成入力規模 ({best_n['avg_parent_refs']:.1f}refs vs oracle M≈4.9) に非対称の疑い。要検証。")
    else:
        md.append(f"- **N={best_n['N']} が最良**: cloud good={best_n['good_pct']:.1f}%, retrieval failure={best_analysis['ret']}/41={best_analysis['ret']/41*100:.1f}%")

    md.append(f"- 8件救済:")
    for r in all_results:
        ar = r["analysis"]
        md.append(f"  - N={r['N']}: {len(ar['rescued'])}/8 rescued={ar['rescued']}, not={ar['not_rescued']}")
    md.append("")
    md.append(f"- **retrieval failure 残存**: N={best_n['N']} で {best_analysis['ret']}/41 = {best_analysis['ret']/41*100:.1f}%")
    if best_analysis['rea'] > best_analysis['ret']:
        md.append(f"- **generation(reasoning failure) が主要律速** ({best_analysis['rea']}/41 = {best_analysis['rea']/41*100:.1f}%)。次の一手は generation 改善。")
    else:
        md.append(f"- retrieval が依然律速。検索精度向上が必要。")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)


def main():
    t0 = time.time()
    print(f"=== parent-doc fix: top-N unique src_id (out/29) ===")
    print(f"k={K}, N∈{NS}")

    gold_dict = load_gold()
    corpus = build_corpus(gold_dict)
    corpus_embeds = load_corpus_embeds()
    edge_qs = [(gid, g) for gid, g in gold_dict.items()
               if g.get("expected") == "edge" and g.get("referencePoints")]

    # retrieve top-k once for all questions (reuse across N)
    print(f"\nretrieving top-{K} for all {len(edge_qs)} questions (once, reused across N)...")
    all_top = {}
    for i, (gid, g) in enumerate(edge_qs):
        all_top[gid] = retrieve_top(g["query"], corpus, corpus_embeds, K)
        if (i + 1) % 10 == 0:
            print(f"  {i+1}/{len(edge_qs)}")

    all_results = []
    for N in NS:
        result = run_N(gold_dict, corpus, corpus_embeds, edge_qs, all_top, N)
        cloud_dict = {o["id"]: o for o in result["rows"]}
        analysis = analysis_for_N(cloud_dict)
        result["analysis"] = analysis
        all_results.append(result)

        # guard check
        if result["good_pct"] > ORACLE_CLOUD_GOOD_PCT + 5:
            print(f"\n⚠️ CRITICAL: N={N} real good ({result['good_pct']:.1f}%) >> oracle ({ORACLE_CLOUD_GOOD_PCT}%). "
                  f"大規模非対称の疑い。生成入力={result['avg_parent_refs']:.1f}refs vs oracle M≈4.9。"
                  f"続行しますが注意。")

    elapsed = time.time() - t0
    write_report(all_results, elapsed)

    print(f"\n[DONE] elapsed={elapsed:.0f}s")


if __name__ == "__main__":
    main()
