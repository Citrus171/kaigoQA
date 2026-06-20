#!/usr/bin/env python3
"""out44: 評価基盤を本番一致させ thinkOFF+V2 を測定。

layer 0: 基盤一致の検算 (recall@3 / top-1 gid。out/31 の 95.1% 再現確認)
layer 1: gen+judge (edge thinkOFF+V2 / cloud flash)。同一 retrieval で比較。
layer 2: oracle(全ref注入, thinkOFF+V2) + 2x2 故障分離

基盤:
  corpus = 本番 models/rag/corpus.json (135 chunks, 1質問1chunk連結)
  embed = CF bge-m3 (@cf/baai/bge-m3, HTTP)
  k = 3 (本番 RETRIEVAL_K)
  judge = 全referencePoints(gold) 統一

env: CF_ACCOUNT_ID, CF_API_TOKEN, OPENCODE_API_KEY, OPENROUTER_API_KEY
"""

import json, os, time, requests, math, re as _re, sys

ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "..")
def P(*a): return os.path.join(ROOT, *a)

# ── env ──
env_path = P("apps/api/.env")
if os.path.exists(env_path):
    for line in open(env_path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

CF_ACC   = os.environ["CF_ACCOUNT_ID"]
CF_TOK   = os.environ["CF_API_TOKEN"]
CF_EMBED_URL = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACC}/ai/run/@cf/baai/bge-m3"
EDGE_MODEL   = "@cf/google/gemma-4-26b-a4b-it"
CF_API       = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACC}/ai/run/{EDGE_MODEL}"

OPENCODE_KEY = os.environ["OPENCODE_API_KEY"]
OPENCODE_URL = "https://opencode.ai/zen/go/v1/chat/completions"
CLOUD_MODEL  = os.environ.get("OPENCODE_MODEL", "deepseek-v4-flash")

ORK          = os.environ["OPENROUTER_API_KEY"]
JUDGE_MODEL  = os.environ.get("JUDGE_MODEL", "openai/gpt-4o")
JUDGE_URL    = "https://openrouter.ai/api/v1/chat/completions"

RETRIEVAL_K  = int(os.environ.get("RAG_K", "3"))
SKIP_ORACLE  = os.environ.get("SKIP_ORACLE", "0") == "1"

# ── paths ──
CORPUS_PATH   = P("apps/api/models/rag/corpus.json")
GOLD_PATH     = P("apps/api/eval/data/routing-gold-a.jsonl")
EDGE_OUT      = P("apps/api/eval/data/rag-mvp-edge-out44.jsonl")
CLOUD_OUT     = P("apps/api/eval/data/rag-mvp-cloud-out44.jsonl")
ORACLE_OUT    = P("apps/api/eval/data/rag-mvp-edge-oracle-out44.jsonl")
RESULT_MD     = P("apps/api/eval/out/44-edge-thinkoff-baseline.md")

# ── prompt V2 (rag-mvp.py L40-51, 本番同等) ──
EDGE_SYSTEM = (
    "あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で答えてください。"
    "回答の参考情報には、質問への回答に必要な事実や条件が含まれています。参考情報に単位数・金額・"
    "加算率・人員要件・算定要件・期間などの具体的な数値や条件が記載されている場合は、省略せず回答に含めてください。"
    "利用者の質問が数値・金額・加算率・算定条件を尋ねている場合、それらは回答の核心情報です。"
    "核心情報は要約や一般論に置き換えず、具体的に記載してください。"
    "「施設にご確認ください」「自治体にご確認ください」などの案内は、参考情報に回答が存在しない場合、"
    "または施設・自治体ごとに運用が異なる事項に限って使用してください。"
    "参考情報に記載されている事実や数値を、この案内によって省略してはいけません。"
    "簡潔さは保ちつつ、利用者の判断に必要な数値・条件は漏れなく回答してください。目安は3〜5文です。"
    "医療診断・投薬指示・法令の断定はしないこと。"
)

# ═══════════════════════════════════════════
# ベクトル演算
# ═══════════════════════════════════════════

def l2normalize(vec):
    norm = math.sqrt(sum(x*x for x in vec))
    return [x/norm for x in vec] if norm else vec[:]

def cosine(a, b):
    return sum(x*y for x,y in zip(a,b))

# ═══════════════════════════════════════════
# corpus: 本番 corpus.json をロード + L2正規化
# ═══════════════════════════════════════════

def load_corpus():
    c = json.load(open(CORPUS_PATH))
    chunks = []
    for ch in c["chunks"]:
        chunks.append({
            "srcId": ch["srcId"],
            "text": ch["text"],
            "vector": l2normalize(ch["vector"]),
        })
    return {
        "embedModel": c["embedModel"],
        "dim": c["dim"],
        "count": c["count"],
        "chunks": chunks,
    }

# ═══════════════════════════════════════════
# CF bge-m3 embed
# ═══════════════════════════════════════════

def cf_embed(texts):
    """CF Workers AI bge-m3 で埋め込み。L2正規化して返す。"""
    r = requests.post(CF_EMBED_URL,
                      headers={"Authorization": f"Bearer {CF_TOK}",
                               "Content-Type": "application/json"},
                      json={"text": texts}, timeout=60)
    r.raise_for_status()
    data = r.json().get("result", {}).get("data", [])
    if len(data) != len(texts):
        raise RuntimeError(f"CF embed mismatch: expected {len(texts)}, got {len(data)}")
    return [l2normalize(d) for d in data]

# ═══════════════════════════════════════════
# retrieval: 本番と同方式
# ═══════════════════════════════════════════

def retrieve(query, corpus, k):
    q_vec = cf_embed([query])[0]
    scored = [(ch["srcId"], ch["text"], cosine(q_vec, ch["vector"]))
              for ch in corpus["chunks"]]
    scored.sort(key=lambda x: -x[2])
    return scored[:k]

# ═══════════════════════════════════════════
# load gold
# ═══════════════════════════════════════════

def load_gold():
    items = [json.loads(l) for l in open(GOLD_PATH) if l.strip()]
    return {g["id"]: g for g in items}

# ═══════════════════════════════════════════
# layer 0: 基盤一致の検算
# ═══════════════════════════════════════════

def layer0_verify(gold_dict, corpus):
    """recall@k と top-1 gid 率。out/31 の 95.1% 再現を確認。"""
    edge_qs = [(gid, g) for gid, g in gold_dict.items()
               if g.get("expected") == "edge" and g.get("referencePoints")]
    print(f"\n=== layer 0: 基盤一致の検算 (corpus={corpus['count']}chunks, k={RETRIEVAL_K}) ===")
    print(f"対象: {len(edge_qs)}件 (edge想定)")
    print(f"embed: CF bge-m3 (dim={corpus['dim']})")

    for k_test in [1, 3]:
        hits = 0
        for gid, g in edge_qs:
            top = retrieve(g["query"], corpus, k_test)
            if gid in {s for s, _, _ in top}:
                hits += 1
        rate = hits / len(edge_qs) * 100
        print(f"  top-{k_test} gid hit: {hits}/{len(edge_qs)} = {rate:.1f}%")

    top1_hits = 0
    for gid, g in edge_qs:
        top = retrieve(g["query"], corpus, 1)
        if gid in {s for s, _, _ in top}:
            top1_hits += 1
    top1_rate = top1_hits / len(edge_qs) * 100
    print(f"  top-1 gid hit: {top1_hits}/{len(edge_qs)} = {top1_rate:.1f}%")

    if top1_rate < 90.0:
        print(f"\n🔴 基盤一致未達: top-1 gid {top1_rate:.1f}% < out/31 の 95.1%。測定中止。")
        print("原因候補: corpus.json or CF embed の不整合")
        sys.exit(1)

    print(f"✅ 基盤一致確認 (top-1 gid rate {top1_rate:.1f}% ≧ 90%) → 測定に進む")
    return top1_rate

# ═══════════════════════════════════════════
# generation
# ═══════════════════════════════════════════

def gen_edge_thinkoff(query, refs):
    """Gemma4 26B Workers AI, thinkOFF + V2"""
    ref_text = "\n".join(f"- {p}" for p in refs)
    sys_p = EDGE_SYSTEM + f"\n\n回答の参考情報（介護保険の事実）:\n{ref_text}"
    payload = {
        "messages": [{"role": "system", "content": sys_p}, {"role": "user", "content": query}],
        "max_tokens": 512,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    max_retries = int(os.environ.get("EDGE_RETRY", "2"))
    for attempt in range(max_retries + 1):
        r = requests.post(CF_API, headers={"Authorization": f"Bearer {CF_TOK}"},
                          json=payload, timeout=180)
        r.raise_for_status()
        ch = (r.json().get("result", {}) or {}).get("choices") or []
        raw = ch[0].get("message", {}).get("content") if ch else None
        content = (raw or "").strip()
        if content:
            return content
        if attempt < max_retries:
            print(f"    retry {attempt+1}/{max_retries} (empty/null content)", flush=True)
            time.sleep(1)
    return ""

def gen_cloud(query, refs):
    """deepseek-v4-flash via OpenCode"""
    ref_text = "\n".join(f"- {pt}" for pt in refs)
    sys_p = EDGE_SYSTEM + f"\n\n回答の参考情報（介護保険の事実）:\n{ref_text}"
    r = requests.post(OPENCODE_URL,
                      headers={"Authorization": f"Bearer {OPENCODE_KEY}",
                               "Content-Type": "application/json"},
                      json={"model": CLOUD_MODEL,
                            "messages": [{"role": "system", "content": sys_p},
                                         {"role": "user", "content": query}]},
                      timeout=120)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()

# ═══════════════════════════════════════════
# judge: 全 referencePoints(gold) 統一
# ═══════════════════════════════════════════

def judge_fullrefs(query, answer, gold_refs):
    """GPT-4o judge。gold の全 referencePoints を参照として渡す（oracle/real 同一）。"""
    ref_text = "\n".join(f"- {pt}" for pt in gold_refs)
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

def isgood(v):
    return bool(v) and v.get("factual") and v.get("sufficient") and not v.get("overreach")

# ═══════════════════════════════════════════
# layer 1: gen + judge (retrieved refs)
# ═══════════════════════════════════════════

def load_existing(path):
    done = {}
    if not os.path.exists(path):
        return done
    for l in open(path):
        if l.strip():
            o = json.loads(l); done[o["id"]] = o
    return done

def run_layer1(gold_dict, corpus):
    """edge / cloud とも同一 retrieval で実RAG生成＋判定。"""
    edge_qs = [(gid, g) for gid, g in gold_dict.items()
               if g.get("expected") == "edge" and g.get("referencePoints")]
    print(f"\n=== layer 1: end-to-end (k={RETRIEVAL_K}, judge=全ref統一) ===")
    print(f"対象: {len(edge_qs)}件 (edge想定)")

    for label, out_path, gen_fn, model_label in [
        ("edge", EDGE_OUT, gen_edge_thinkoff, "Gemma4 thinkOFF+V2"),
        ("cloud", CLOUD_OUT, gen_cloud, CLOUD_MODEL),
    ]:
        done = load_existing(out_path)
        print(f"\n── {label} (model={model_label}) ──")
        print(f"  既処理: {len(done)}件スキップ")

        with open(out_path, "a") as fout:
            for i, (gid, g) in enumerate(edge_qs):
                if gid in done:
                    continue
                top = retrieve(g["query"], corpus, RETRIEVAL_K)
                refs = [text for _, text, _ in top]
                ref_srcs = [s for s, _, _ in top]
                rec = {"id": gid, "query": g["query"], "expected": g.get("expected"),
                       "category": g.get("category"), "k": RETRIEVAL_K,
                       "retrieved_srcs": ref_srcs,
                       "hit_src_id": gid in set(ref_srcs)}

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

                # judge は gold の全 referencePoints を渡す（oracle/real 同一）
                gold_refs = g.get("referencePoints", [])
                if ans and gold_refs:
                    try:
                        rec["verdict"] = judge_fullrefs(g["query"], ans, gold_refs)
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

# ═══════════════════════════════════════════
# layer 2: oracle (全ref注入, thinkOFF+V2) + 2x2
# ═══════════════════════════════════════════

def run_layer2(gold_dict):
    """oracle: 全 referencePoints を直接注入 (retrieval 不使用)。thinkOFF+V2。"""
    edge_qs = [(gid, g) for gid, g in gold_dict.items()
               if g.get("expected") == "edge" and g.get("referencePoints")]
    if SKIP_ORACLE:
        print(f"\n=== layer 2: oracle (全ref注入) skipped ===")
        return

    print(f"\n=== layer 2: oracle (全ref注入, thinkOFF+V2) ===")
    done = load_existing(ORACLE_OUT)
    print(f"  既処理: {len(done)}件スキップ")

    with open(ORACLE_OUT, "a") as fout:
        for i, (gid, g) in enumerate(edge_qs):
            if gid in done:
                continue
            gold_refs = g.get("referencePoints", [])
            t0 = time.time()
            try:
                ans = gen_edge_thinkoff(g["query"], gold_refs)
                rec = {"id": gid, "query": g["query"], "genFailed": False, "answer": ans}
            except Exception as ex:
                rec = {"id": gid, "query": g["query"], "genFailed": True,
                       "genError": str(ex)[:120], "answer": ""}
                print(f"  [{i+1}/{len(edge_qs)}] {gid} gen FAIL", flush=True)
            rec["latencyMs"] = int((time.time() - t0) * 1000)

            if rec["answer"] and gold_refs:
                try:
                    rec["verdict"] = judge_fullrefs(g["query"], rec["answer"], gold_refs)
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

    rows = [json.loads(l) for l in open(ORACLE_OUT) if l.strip()]
    g = sum(1 for r in rows if r.get("good"))
    print(f"  result: {g}/{len(rows)} = {g/len(rows)*100:.1f}% good")

# ═══════════════════════════════════════════
# 2x2 failure analysis
# ═══════════════════════════════════════════

def two_by_two(oracle_dict, real_dict, label):
    ids = set(oracle_dict) & set(real_dict)
    oracle_good = 0
    both_ok = 0
    retrieval_failure = 0
    reasoning_failure = 0
    odd = 0

    for gid in sorted(ids):
        og = bool(oracle_dict[gid].get("good"))
        rg = bool(real_dict[gid].get("good"))
        if og:
            oracle_good += 1
            if rg:
                both_ok += 1
            else:
                retrieval_failure += 1
        else:
            if rg:
                odd += 1
            else:
                reasoning_failure += 1

    n = len(ids)
    real_good = both_ok + odd
    lines = []
    lines.append(f"\n## 2×2: {label}")
    lines.append("")
    lines.append("| | 実RAG good | 実RAG bad |")
    lines.append("|---|---|---|")
    lines.append(f"| **Oracle good** | {both_ok} (検索も推論もOK) | {retrieval_failure} (retrieval failure) |")
    lines.append(f"| **Oracle bad** | {odd} (稀) | {reasoning_failure} (reasoning/capacity failure) |")
    lines.append("")
    lines.append(f"- oracle good: {oracle_good}/{n} = {oracle_good/n*100:.1f}%")
    lines.append(f"- 実RAG good: {real_good}/{n} = {real_good/n*100:.1f}%")
    lines.append(f"- retrieval loss: {oracle_good/n*100:.1f}% → {real_good/n*100:.1f}% (Δ={abs(oracle_good-real_good)/n*100:.1f}pts)")
    lines.append(f"- retrieval failure: {retrieval_failure}/{n} ({retrieval_failure/n*100:.1f}%)")
    lines.append(f"- reasoning failure: {reasoning_failure}/{n} ({reasoning_failure/n*100:.1f}%)")
    return {"label": label, "n": n, "oracle_good": oracle_good, "real_good": real_good,
            "both_ok": both_ok, "retrieval_failure": retrieval_failure,
            "reasoning_failure": reasoning_failure, "odd": odd, "lines": lines}

# ═══════════════════════════════════════════
# latency stats
# ═══════════════════════════════════════════

def latency_stats(rows):
    vals = sorted([r["latencyMs"] for r in rows])
    n = len(vals)
    return {
        "avg": sum(vals)/n, "p50": vals[n//2], "min": vals[0], "max": vals[-1],
        "p95": vals[int(n*0.95)], "p99": vals[int(n*0.99)] if int(n*0.99) < n else vals[-1],
    }

def empty_rate(rows):
    return sum(1 for r in rows if not r.get("answer"))

# ═══════════════════════════════════════════
# main
# ═══════════════════════════════════════════

def main():
    t0 = time.time()
    print(f"=== out44: edge thinkOFF+V2 本番基盤測定 (k={RETRIEVAL_K}) ===")

    gold_dict = load_gold()
    print(f"gold: {len(gold_dict)} questions")
    corpus = load_corpus()
    print(f"corpus: {corpus['count']} chunks ({corpus['embedModel']}, dim={corpus['dim']})")

    # layer 0: 基盤一致の検算
    top1_rate = layer0_verify(gold_dict, corpus)

    # layer 1: edge + cloud
    run_layer1(gold_dict, corpus)

    # layer 2: oracle
    run_layer2(gold_dict)

    # ── レポート生成 ──
    edge_rows = [json.loads(l) for l in open(EDGE_OUT) if l.strip()] if os.path.exists(EDGE_OUT) else []
    cloud_rows = [json.loads(l) for l in open(CLOUD_OUT) if l.strip()] if os.path.exists(CLOUD_OUT) else []
    oracle_rows = [json.loads(l) for l in open(ORACLE_OUT) if l.strip()] if os.path.exists(ORACLE_OUT) else []

    elapsed = time.time() - t0
    md = []
    md.append("# 44: edge(Gemma4 thinkOFF+V2) 本番基盤 実RAG k=3 測定")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 構成")
    md.append(f"- corpus: 本番 `models/rag/corpus.json` ({corpus['count']} chunks, 1質問1chunk連結)")
    md.append(f"- embed: CF bge-m3 (@cf/baai/bge-m3, dim={corpus['dim']})")
    md.append(f"- 検索: cosine top-k (k={RETRIEVAL_K})")
    md.append(f"- edge model: Gemma4 26B thinkOFF+V2 (Workers AI)")
    md.append(f"- cloud model: {CLOUD_MODEL} (OpenCode)")
    md.append(f"- judge: {JUDGE_MODEL} (OpenRouter, temp=0, 全referencePoints統一)")
    md.append(f"- 対象: edge想定 ({len([g for g in gold_dict.values() if g.get('expected')=='edge' and g.get('referencePoints')])}件)")
    md.append("")

    # 基盤一致検算
    md.append("## layer 0: 基盤一致の検算")
    md.append("")
    md.append(f"- top-1 gid 率: **{top1_rate:.1f}%** (out/31: 95.1%)")

    if edge_rows:
        md.append("")
        md.append("## retrieval 結果 (k=3)")
        md.append("")
        ed_g = sum(1 for r in edge_rows if r.get("good"))
        ed_hit = sum(1 for r in edge_rows if r.get("hit_src_id"))
        md.append(f"- edge: {ed_g}/{len(edge_rows)} = {ed_g/len(edge_rows)*100:.1f}% good (hit rate={ed_hit}/{len(edge_rows)}={ed_hit/len(edge_rows)*100:.1f}%)")
        md.append(f"- gen空答案: {empty_rate(edge_rows)}/{len(edge_rows)} = {empty_rate(edge_rows)/len(edge_rows)*100:.1f}%")

        ls = latency_stats(edge_rows)
        md.append(f"- latency(edge): avg={ls['avg']:.0f}ms / p50={ls['p50']:.0f}ms / p95={ls['p95']:.0f}ms / max={ls['max']}ms")

    if cloud_rows:
        cl_g = sum(1 for r in cloud_rows if r.get("good"))
        cl_hit = sum(1 for r in cloud_rows if r.get("hit_src_id"))
        md.append(f"- cloud: {cl_g}/{len(cloud_rows)} = {cl_g/len(cloud_rows)*100:.1f}% good (hit rate={cl_hit}/{len(cloud_rows)}={cl_hit/len(cloud_rows)*100:.1f}%)")

        ls = latency_stats(cloud_rows)
        md.append(f"- latency(cloud): avg={ls['avg']:.0f}ms / p50={ls['p50']:.0f}ms / p95={ls['p95']:.0f}ms / max={ls['max']}ms")

    if oracle_rows:
        md.append(f"- oracle: {sum(1 for r in oracle_rows if r.get('good'))}/{len(oracle_rows)} = {sum(1 for r in oracle_rows if r.get('good'))/len(oracle_rows)*100:.1f}% good")
        ls = latency_stats(oracle_rows)
        md.append(f"- latency(oracle): avg={ls['avg']:.0f}ms / p50={ls['p50']:.0f}ms / p95={ls['p95']:.0f}ms / max={ls['max']}ms")

    # 2x2
    oracle_dict = {r["id"]: r for r in oracle_rows}
    if oracle_dict and edge_rows:
        edge_real_dict = {r["id"]: r for r in edge_rows}
        er = two_by_two(oracle_dict, edge_real_dict, "Edge (Gemma4 thinkOFF+V2)")
        md.extend(er["lines"])
        md.append("")

    if oracle_dict and cloud_rows:
        cloud_real_dict = {r["id"]: r for r in cloud_rows}
        cr = two_by_two(oracle_dict, cloud_real_dict, "Cloud (deepseek-v4-flash)")
        md.extend(cr["lines"])
        md.append("")

    # 考察
    md.append("## 考察")
    md.append("")
    md.append(f"- 基盤一致: top-1 gid {top1_rate:.1f}% (out/31 95.1% 比)")
    if edge_rows:
        md.append(f"- edge thinkOFF+V2 実RAG: {ed_g}/{len(edge_rows)} = {ed_g/len(edge_rows)*100:.1f}% good")
        md.append(f"- 空答案率: {empty_rate(edge_rows)}/{len(edge_rows)} = {empty_rate(edge_rows)/len(edge_rows)*100:.1f}% (out43 thinkON: 9.8%)")
    if cloud_rows:
        md.append(f"- cloud flash 実RAG: {cl_g}/{len(cloud_rows)} = {cl_g/len(cloud_rows)*100:.1f}% good")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)


if __name__ == "__main__":
    main()
