#!/usr/bin/env python3
"""out/27: retrieval 網羅性の定量化と k 掃引。

Phase 1（生成不要・安い）: 現recall定義を拡張し k∈{5,8,12,16,20,30} で3指標を掃引
  - hit-rate@k    : 現定義（src_idが1個でもtop-kに入った質問率、比較用）
  - coverage@k    : 平均 hit_i / M_i（全要点のうち何割がtop-kに）
  - full-coverage@k: hit_i == M_i（全要点が揃った質問率）←judge sufficientに最も近い

Phase 2（重い・--phase2 で実行）: full-coverage が回復する k で再生成→全ref judge→2×2
  生成は rag-mvp.py の gen_edge/gen_cloud。judge は再測定版（全ref統一）。
  env RAG_K または --k で生成用 k を指定。

usage:
  python3 retrieval-coverage.py              # Phase 1 のみ
  python3 retrieval-coverage.py --phase2     # Phase 1 + Phase 2 (k=20, --k で変更可)
  python3 retrieval-coverage.py -k 30        # Phase 1 + Phase 2 with k=30
  python3 retrieval-coverage.py --no-phase1  # Phase 2 のみ（Phase1結果が既に既知の場合）
"""
import json, os, time, math, re as _re, sys
import requests
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT  = os.path.join(HERE, "out")

# ── env ──
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

# ── paths ──
GOLD_PATH    = os.path.join(DATA, "routing-gold-a.jsonl")
EMBED_CACHE  = os.path.join(DATA, "rag-corpus-embeddings.json")
EDGE_ORACLE  = os.path.join(DATA, "phaseA-gemma4-incontext-results-edge-thinkoff.json")
CLOUD_ORACLE = os.path.join(DATA, "measA-cloud-rag-edge.jsonl")
RESULT_MD    = os.path.join(OUT, "27-retrieval-coverage.md")

KS = [5, 8, 12, 16, 20, 30]

# ── args ──
DO_PHASE2   = "--phase2" in sys.argv
SKIP_PHASE1 = "--no-phase1" in sys.argv
GEN_K = int(os.environ.get("RAG_K", "20"))
for i, a in enumerate(sys.argv):
    if a in ("-k", "--k") and i + 1 < len(sys.argv):
        GEN_K = int(sys.argv[i + 1])
        DO_PHASE2 = True
        break

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


def gen_edge(query, refs):
    ref_text = "\n".join(f"- {p}" for p in refs)
    sys_p = EDGE_SYSTEM_PROMPT + f"\n\n回答の参考情報（介護保険の事実）:\n{ref_text}"
    r = requests.post(CF_API,
                      headers={"Authorization": f"Bearer {CF_TOK}"},
                      json={"messages": [{"role": "system", "content": sys_p},
                                         {"role": "user", "content": query}],
                            "max_tokens": 512,
                            "chat_template_kwargs": {"enable_thinking": False}},
                      timeout=180)
    r.raise_for_status()
    ch = (r.json().get("result", {}) or {}).get("choices") or []
    return (ch[0].get("message", {}).get("content", "") if ch else "").strip()


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
    items = [json.loads(l) for l in open(GOLD_PATH) if l.strip()]
    return {g["id"]: g for g in items}


def build_corpus(gold_dict):
    corpus = []
    for g in gold_dict.values():
        for pt in (g.get("referencePoints") or []):
            corpus.append({"src_id": g["id"], "text": pt})
    return corpus


def load_corpus_embeds():
    if not os.path.exists(EMBED_CACHE):
        raise FileNotFoundError(f"embed cache not found: {EMBED_CACHE}")
    print(f"[embed] cache hit: {EMBED_CACHE}")
    return json.load(open(EMBED_CACHE))["embeddings"]


def retrieve_all(query, corpus, corpus_embeds, max_k):
    q_emb = embed_query(query)
    scores = [(i, cos(q_emb, ce)) for i, ce in enumerate(corpus_embeds)]
    scores.sort(key=lambda x: -x[1])
    return [(corpus[si]["src_id"], corpus[si]["text"], sc) for si, sc in scores[:max_k]]


def phase1(gold_dict, corpus, corpus_embeds):
    edge_qs = [(gid, g) for gid, g in gold_dict.items()
               if g.get("expected") == "edge" and g.get("referencePoints")]
    max_k = max(KS)
    print(f"\n=== Phase 1: coverage k-sweep (k in {KS}) ===")
    print(f"target: {len(edge_qs)} edge questions, max_k={max_k}")

    mi_list = {}
    for gid, g in edge_qs:
        mi_list[gid] = len(g["referencePoints"])

    all_top = {}
    print("retrieving top-max_k for all questions ...")
    t0 = time.time()
    for i, (gid, g) in enumerate(edge_qs):
        all_top[gid] = retrieve_all(g["query"], corpus, corpus_embeds, max_k)
        if (i + 1) % 10 == 0:
            elapsed = time.time() - t0
            print(f"  {i+1}/{len(edge_qs)} ({elapsed:.0f}s)")
    print(f"  retrieval done ({time.time()-t0:.0f}s)")

    results = {}
    for k in KS:
        hit_n = 0
        total_cov = 0.0
        full_n = 0
        for gid, _ in edge_qs:
            top_k_srcs = [s for s, _, _ in all_top[gid][:k]]
            hit_i = top_k_srcs.count(gid)
            M = mi_list[gid]
            if hit_i > 0:
                hit_n += 1
            total_cov += hit_i / M
            if hit_i == M:
                full_n += 1
        n = len(edge_qs)
        results[k] = {
            "hit_rate": (hit_n, n, hit_n / n),
            "coverage": total_cov / n,
            "full_coverage": (full_n, n, full_n / n),
        }

    return edge_qs, mi_list, results, all_top


def phase2(gold_dict, corpus, corpus_embeds, edge_qs, all_top, gen_k):
    print(f"\n=== Phase 2: gen+judge validation at k={gen_k} ===")

    out_files = {
        "edge": os.path.join(DATA, f"rag-mvp-edge-k{gen_k}.jsonl"),
        "cloud": os.path.join(DATA, f"rag-mvp-cloud-k{gen_k}.jsonl"),
    }

    for label, out_path, gen_fn in [
        ("edge", out_files["edge"], gen_edge),
        ("cloud", out_files["cloud"], gen_cloud),
    ]:
        print(f"\n  {label} (k={gen_k})")
        with open(out_path, "w") as fout:
            for i, (gid, g) in enumerate(edge_qs):
                top = [t for t in all_top[gid][:gen_k] if t[1].strip()]
                refs = [text for _, text, _ in top]
                ref_srcs = [src for src, _, _ in top]

                rec = {"id": gid, "query": g["query"], "expected": g.get("expected"),
                       "category": g.get("category"), "k": gen_k,
                       "retrieved_srcs": ref_srcs}

                t0 = time.time()
                try:
                    ans = gen_fn(g["query"], refs)
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
                print(f"  [{i+1}/{len(edge_qs)}] {gid} {gd} {rec['latencyMs']}ms", flush=True)
                time.sleep(0.2)

        rows = [json.loads(l) for l in open(out_path) if l.strip()]
        g = sum(1 for r in rows if r.get("good"))
        print(f"  result: {g}/{len(rows)} = {g/len(rows)*100:.1f}% good")

    return out_files


def load_rejudge_oracles():
    """rejudge-out26-verdicts.json から全ref統一採点済みの oracle verdict を読む"""
    cache_path = os.path.join(DATA, "rejudge-out26-verdicts.json")
    if not os.path.exists(cache_path):
        print(f"WARN: rejudge cache not found: {cache_path}")
        return {}, {}
    v = json.load(open(cache_path))
    return v.get("oracle_edge", {}), v.get("oracle_cloud", {})


def load_jsonl(path):
    return {o["id"]: o for o in (json.loads(l) for l in open(path) if l.strip())}


def phase2_analysis(gen_k):
    print("\n=== Phase 2: 2x2 analysis ===")

    oracle_edge_verdicts, oracle_cloud_verdicts = load_rejudge_oracles()

    edge_real = load_jsonl(os.path.join(DATA, f"rag-mvp-edge-k{gen_k}.jsonl"))
    cloud_real = load_jsonl(os.path.join(DATA, f"rag-mvp-cloud-k{gen_k}.jsonl"))

    common_ids = sorted(set(oracle_edge_verdicts) & set(edge_real))
    print(f"common ids (edge): {len(common_ids)}")

    results = {}

    def two_by_two(oracle_v, real_dict, label):
        ids = sorted(set(oracle_v) & set(real_dict))
        both = ret = odd = rea = 0
        ret_ids, odd_ids = [], []
        for gid in ids:
            og = isgood(oracle_v[gid])
            rv = real_dict[gid].get("verdict") or real_dict[gid]
            rg = isgood(rv)
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
        og_pct = og_n / n * 100
        rg_pct = rg_n / n * 100
        print(f"\n## 2x2: {label} (n={n}, k={gen_k}, same judge / full refs)")
        print(f"|                | real good | real bad |")
        print(f"| Oracle good    | {both:>2} (both ok)  | {ret:>2} (retrieval failure) |")
        print(f"| Oracle bad     | {odd:>2} (rare) | {rea:>2} (reasoning failure)  |")
        print(f"- oracle good: {og_n}/{n} = {og_pct:.1f}%")
        print(f"- real good  : {rg_n}/{n} = {rg_pct:.1f}%")
        print(f"- retrieval loss: {og_pct:.1f}% -> {rg_pct:.1f}% (delta={rg_pct-og_pct:+.1f}pts)")
        print(f"- retrieval failure: {ret}/{n} = {ret/n*100:.1f}%  ids={ret_ids}")
        print(f"- reasoning failure: {rea}/{n} = {rea/n*100:.1f}%")
        print(f"- odd: {odd}/{n} = {odd/n*100:.1f}%  ids={odd_ids}")

        return dict(n=n, both=both, ret=ret, odd=odd, rea=rea,
                    og_n=og_n, rg_n=rg_n, og_pct=og_pct, rg_pct=rg_pct,
                    ret_ids=ret_ids, odd_ids=odd_ids)

    results["edge"] = two_by_two(oracle_edge_verdicts, edge_real, "EDGE (Gemma4 thinkOFF)")
    results["cloud"] = two_by_two(oracle_cloud_verdicts, cloud_real, "CLOUD (deepseek-v4-flash)")

    return results


def write_report(edge_qs, mi_list, p1_results, gen_k, p2_results, corpus_len):
    md = []
    md.append("# 27: retrieval 網羅性の定量化と k 掃引")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}`")
    md.append("")
    md.append("## 背景")
    md.append("")
    md.append("- out/26 再測定: 実RAG(k=5)の retrieval loss は edge -17.1pt / cloud -22.0pt")
    md.append("- 真因: recall@k定義(1hit)と judge sufficient(全要点)の不整合")
    md.append("- 本レポート: recall を再定義し k 掃引で retrieval 網羅性と律速を定量化")
    md.append("")
    md.append("## 構成")
    md.append("")
    md.append(f"- corpus: {corpus_len} chunks（全質問の全referencePoints＝検索空間。embed cache流用）/ 評価対象={len(edge_qs)}質問(edge想定)")
    md.append("- embed: bge-m3 (ollama, dim=1024) - キャッシュ流用")
    md.append(f"- 検索: cosine top-k, k sweep {KS}")
    md.append(f"- 評価対象: edge 想定 {len(edge_qs)}件")
    md.append("")
    md.append("## M_i 分布（質問ごとの referencePoints 数）")
    md.append("")
    mi_vals = sorted(mi_list.values())
    md.append(f"- min={min(mi_vals)}, max={max(mi_vals)}, median={mi_vals[len(mi_vals)//2]}, mean={sum(mi_vals)/len(mi_vals):.1f}")
    md.append("")
    md.append("| M_i | count |")
    md.append("|-----|-------|")
    for m, cnt in sorted(Counter(mi_vals).items()):
        md.append(f"| {m} | {cnt} |")
    md.append("")

    if p1_results:
        md.append("## Phase 1: k sweep 3 metrics")
        md.append("")
        md.append("| k | hit-rate@k (current) | coverage@k (avg point coverage) | full-coverage@k (all points) |")
        md.append("|---|---|---|---|")
        for k in KS:
            r = p1_results[k]
            md.append(f"| {k} | {r['hit_rate'][0]}/{r['hit_rate'][1]} = {r['hit_rate'][2]*100:.1f}% "
                      f"| {r['coverage']*100:.1f}% "
                      f"| {r['full_coverage'][0]}/{r['full_coverage'][1]} = {r['full_coverage'][2]*100:.1f}% |")
        md.append("")

        md.append("### 指標の定義")
        md.append("")
        md.append("- **hit-rate@k**: 質問の referencePoints のうち1個でも top-k に入った質問率（現 recall 定義・比較用）")
        md.append("- **coverage@k**: 平均 `hit_i / M_i`（全要点のうち何割が top-k に入ったか）")
        md.append("- **full-coverage@k**: `hit_i == M_i`（全要点が揃った）質問率（judge sufficient に最も近い）")
        md.append("")
        md.append("### 考察（Phase 1）")
        md.append("")
        fc5 = p1_results[5]['full_coverage'][2] * 100
        hit5 = p1_results[5]['hit_rate'][2] * 100
        md.append(f"- recall@5={hit5:.1f}%(hit-rate) に対し full-coverage@5={fc5:.1f}%。")
        md.append(f"- この差が out/26 再測定の retrieval loss (edge -17.1pt / cloud -22.0pt) の機械的説明:")
        md.append(f"  k=5 では各質問の全要点が揃わず、答案が情報不足になる。")
        k30_fc = p1_results[30]['full_coverage'][2] * 100
        k20_fc = p1_results[20]['full_coverage'][2] * 100
        md.append(f"- k=20 で full-coverage={k20_fc:.1f}%, k=30 で {k30_fc:.1f}%。")
        c5 = p1_results[5]['coverage'] * 100
        c30 = p1_results[30]['coverage'] * 100
        md.append(f"- coverage は k=5 で {c5:.0f}% -> k=30 で {c30:.0f}% に回復。")
        md.append("")

    if p2_results:
        er = p2_results["edge"]
        cr = p2_results["cloud"]
        md.append(f"## Phase 2: k={gen_k} 生成検証")
        md.append("")
        md.append(f"- edge model: Gemma4 26B thinkOFF (Workers AI)")
        md.append(f"- cloud model: {CLOUD_MODEL} (OpenCode)")
        md.append(f"- judge: {JUDGE_MODEL} (OpenRouter, temp=0, 全ref統一)")
        md.append(f"- 生成用 k={gen_k}, 評価用 n={er['n']}件")
        md.append("")

        for label, r in [("EDGE (Gemma4 thinkOFF)", er), (f"CLOUD ({CLOUD_MODEL})", cr)]:
            md.append(f"### 2×2: {label}, k={gen_k}")
            md.append("")
            md.append("| | real good | real bad |")
            md.append("|---|---|---|")
            md.append(f"| **Oracle good** | {r['both']} (both ok) | {r['ret']} (retrieval failure) |")
            md.append(f"| **Oracle bad** | {r['odd']} (rare) | {r['rea']} (reasoning failure) |")
            md.append("")
            md.append(f"- oracle good: {r['og_n']}/{r['n']} = {r['og_pct']:.1f}%")
            md.append(f"- real good: {r['rg_n']}/{r['n']} = {r['rg_pct']:.1f}%")
            md.append(f"- retrieval loss: {r['og_pct']:.1f}% -> {r['rg_pct']:.1f}% (delta={r['rg_pct']-r['og_pct']:+.1f}pts)")
            md.append(f"- retrieval failure: {r['ret']}/{r['n']} = {r['ret']/r['n']*100:.1f}%")
            md.append(f"- reasoning failure: {r['rea']}/{r['n']} = {r['rea']/r['n']*100:.1f}%")
            md.append("")

        md.append("### k=5（out/26再測定）との比較")
        md.append("")
        md.append(f"| | k=5 (out/26) | k={gen_k} (本測定) | delta |")
        md.append("|---|---|---|---|")
        edge_k5 = 14.6
        cloud_k5 = 39.0
        edge_delta = er['rg_pct'] - edge_k5
        cloud_delta = cr['rg_pct'] - cloud_k5
        md.append(f"| edge good | {edge_k5:.1f}% | {er['rg_pct']:.1f}% | {edge_delta:+.1f}pt |")
        md.append(f"| cloud good | {cloud_k5:.1f}% | {cr['rg_pct']:.1f}% | {cloud_delta:+.1f}pt |")
        md.append("")

        # real-selective ceiling at k=gen_k
        md.append("### real-selective 天井 (k=gen_k)")
        md.append("")
        if cr['rg_pct'] >= er['rg_pct']:
            md.append(f"- real-cloud {cr['rg_pct']:.1f}% vs real-edge {er['rg_pct']:.1f}%")
            md.append(f"- selective 上乗せ幅: {cr['rg_pct'] - er['rg_pct']:+.1f}pt")
        else:
            md.append(f"- real-edge {er['rg_pct']:.1f}% > real-cloud {cr['rg_pct']:.1f}% (cloud fallback not beneficial)")

        md.append("")
        md.append("### 結論")
        md.append("")
        if edge_delta > 5 or cloud_delta > 5:
            md.append(f"- **k 拡大は有効。retrieval 網羅性が律速の一部であることが定量的に確認できた。**")
        else:
            md.append(f"- k 拡大の効果は限定的。retrieval 網羅性以上に **generation(reasoning failure) が真の天井**の可能性が高い。")
        md.append(f"- 残る reasoning failure: edge {er['rea']}/{er['n']} ({er['rea']/er['n']*100:.1f}%), cloud {cr['rea']}/{cr['n']} ({cr['rea']/cr['n']*100:.1f}%)。")
        md.append("- この値が retrieval failure を大きく上回る場合、次の投資先は chunk設計変更や generation改善となる。")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)


def main():
    t0 = time.time()
    print(f"=== retrieval coverage k-sweep (out/27) ===")
    print(f"gen_k={GEN_K}, phase1={'ON' if not SKIP_PHASE1 else 'OFF'}, phase2={'ON' if DO_PHASE2 else 'OFF'}")

    gold_dict = load_gold()
    corpus = build_corpus(gold_dict)
    corpus_embeds = load_corpus_embeds()

    edge_qs = None
    mi_list = None
    p1_results = None
    all_top = None

    if not SKIP_PHASE1:
        edge_qs, mi_list, p1_results, all_top = phase1(gold_dict, corpus, corpus_embeds)
    else:
        edge_qs = [(gid, g) for gid, g in gold_dict.items()
                    if g.get("expected") == "edge" and g.get("referencePoints")]
        mi_list = {gid: len(g["referencePoints"]) for gid, g in edge_qs}
        p1_results = {}
        max_k = max(KS)
        all_top = {}
        print(f"recomputing top-{max_k} for phase2 ...")
        for gid, g in edge_qs:
            all_top[gid] = retrieve_all(g["query"], corpus, corpus_embeds, max_k)

    p2_results = None
    if DO_PHASE2:
        phase2(gold_dict, corpus, corpus_embeds, edge_qs, all_top, GEN_K)
        p2_results = phase2_analysis(GEN_K)

    if not SKIP_PHASE1 or DO_PHASE2:
        write_report(edge_qs, mi_list, p1_results, GEN_K, p2_results, len(corpus))

    print(f"\n[DONE] elapsed={time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
