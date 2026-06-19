#!/usr/bin/env python3
"""実RAG MVP: oracle参照注入→実検索(retrieval)に置換。retrieval品質の律速を測る。

layer 1: recall@k（生成不要・安い）- 常に実行
layer 2: gen+judge with retrieved refs - SKIP_LAYER2=1 でスキップ可
layer 3: 2x2故障分離 + retrieval loss + out/26 markdown

env: CF_ACCOUNT_ID, CF_API_TOKEN, OPENCODE_API_KEY, OPENROUTER_API_KEY
"""

import json, os, time, requests, math, re as _re, sys

ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "..")
def P(*a): return os.path.join(ROOT, *a)

GOLD_PATH      = P("apps/api/eval/data/routing-gold-a.jsonl")
CORPUS_CACHE   = P("apps/api/eval/data/rag-corpus-embeddings.json")
EDGE_OUT       = P("apps/api/eval/data/rag-mvp-edge.jsonl")
CLOUD_OUT      = P("apps/api/eval/data/rag-mvp-cloud.jsonl")
RESULT_MD      = P("apps/api/eval/out/26-rag-mvp-result.md")
EDGE_ORACLE_P  = P("apps/api/eval/data/phaseA-gemma4-incontext-results-edge-thinkoff.json")
CLOUD_ORACLE_P = P("apps/api/eval/data/measA-cloud-rag-edge.jsonl")

RETRIEVAL_K    = int(os.environ.get("RAG_K", "5"))
SKIP_LAYER2    = os.environ.get("SKIP_LAYER2", "0") == "1"
EMBED_BATCH    = 100

# ── env ──
env_path = P("apps/api/.env")
if os.path.exists(env_path):
    for line in open(env_path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

# prompt V2（out/35 calc +25pt / out/36 easy +7.3pt・回帰ゼロで本番採用、2026-06-19）
# 設計意図: 「確認済み事実だから断定しろ」ではなく「retrieval の数値を省略するな」に寄せる
# （検索ミス・古い情報混入時の根拠なき断定を避けるため「絶対正しい」とは言わない）
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

OLLAMA_URL  = "http://localhost:11434/api/embed"
EMBED_MODEL = "bge-m3"

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


def isgood(v):
    return bool(v) and v.get("factual") and v.get("sufficient") and not v.get("overreach")


# ═══════════════════════════════════════════
# layer 1: corpus + embed + recall@k
# ═══════════════════════════════════════════

def load_gold():
    items = [json.loads(l) for l in open(GOLD_PATH) if l.strip()]
    return {g["id"]: g for g in items}

def build_corpus(gold_dict):
    """全referencePointsをchunk化。重複保持。"""
    corpus = []
    for g in gold_dict.values():
        for pt in (g.get("referencePoints") or []):
            corpus.append({"src_id": g["id"], "text": pt})
    return corpus

def cos(a, b):
    d = sum(x*y for x,y in zip(a,b))
    na = math.sqrt(sum(x*x for x in a))
    nb = math.sqrt(sum(y*y for y in b))
    return d/(na*nb) if na and nb else 0.0

def embed_texts(texts):
    """bge-m3 batch embed。ollama /api/embed に投げる。"""
    r = requests.post(OLLAMA_URL, json={"model": EMBED_MODEL, "input": texts}, timeout=600)
    r.raise_for_status()
    return r.json()["embeddings"]

def embed_corpus(corpus):
    """コーパス全文をembed。キャッシュあれば読む。"""
    if os.path.exists(CORPUS_CACHE):
        print(f"[embed] cache hit: {CORPUS_CACHE}")
        return json.load(open(CORPUS_CACHE))["embeddings"]

    total = len(corpus)
    all_embeds = []
    print(f"[embed] {total} chunks, batch size={EMBED_BATCH} ...")
    t0 = time.time()
    for i in range(0, total, EMBED_BATCH):
        batch = [c["text"] for c in corpus[i:i+EMBED_BATCH]]
        embeds = embed_texts(batch)
        all_embeds.extend(embeds)
        elapsed = time.time() - t0
        print(f"  {min(i+EMBED_BATCH,total)}/{total} ({elapsed:.0f}s)")
    json.dump({"embeddings": all_embeds}, open(CORPUS_CACHE, "w"), ensure_ascii=False)
    print(f"[embed] saved: {CORPUS_CACHE} ({elapsed:.0f}s total)")
    return all_embeds

def retrieve(query, corpus, corpus_embeds, k):
    """質問をembedし全chunkとcosine → top-k [(src_id, text, sim)]"""
    q_emb = embed_texts([query])[0]
    scores = [(i, cos(q_emb, ce)) for i, ce in enumerate(corpus_embeds)]
    scores.sort(key=lambda x: -x[1])
    return [(corpus[si]["src_id"], corpus[si]["text"], sc) for si, sc in scores[:k]]

def compute_recall_at_k(gold_dict, corpus, corpus_embeds, ks=[3,5,8]):
    """edge想定のみで recall@k 計算"""
    edge_qs = [(gid, g) for gid, g in gold_dict.items()
               if g.get("expected") == "edge" and g.get("referencePoints")]
    results = {}
    for k in ks:
        hits = 0
        for gid, g in edge_qs:
            top = retrieve(g["query"], corpus, corpus_embeds, k)
            if gid in {s for s, _, _ in top}:
                hits += 1
        results[k] = (hits, len(edge_qs))
    return results, edge_qs

def run_layer1():
    gold_dict = load_gold()
    corpus = build_corpus(gold_dict)
    print(f"[corpus] {len(corpus)} chunks from {len(gold_dict)} questions")

    corpus_embeds = embed_corpus(corpus)

    print("\n=== layer 1: recall@k ===")
    recall_results, edge_qs = compute_recall_at_k(gold_dict, corpus, corpus_embeds)
    for k in sorted(recall_results):
        h, n = recall_results[k]
        print(f"  recall@{k}: {h}/{n} = {h/n*100:.1f}%")

    return gold_dict, corpus, corpus_embeds, recall_results, edge_qs


# ═══════════════════════════════════════════
# layer 2: gen + judge (retrieved refs)
# ═══════════════════════════════════════════

def gen_edge(query, refs):
    """Gemma4 26B Workers AI, thinkOFF"""
    ref_text = "\n".join(f"- {p}" for p in refs)
    sys_p = EDGE_SYSTEM + f"\n\n回答の参考情報（介護保険の事実）:\n{ref_text}"
    payload = {
        "messages": [{"role": "system", "content": sys_p}, {"role": "user", "content": query}],
        "max_tokens": 512,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    r = requests.post(CF_API, headers={"Authorization": f"Bearer {CF_TOK}"},
                      json=payload, timeout=180)
    r.raise_for_status()
    ch = (r.json().get("result", {}) or {}).get("choices") or []
    return (ch[0].get("message", {}).get("content", "") if ch else "").strip()

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

def judge(query, answer, refs):
    """GPT-4o judge（参照あり採点）"""
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

def load_existing(path):
    """jsonl or json dict から {id: dict} を作る"""
    done = {}
    if not os.path.exists(path):
        return done
    if path.endswith(".jsonl"):
        for l in open(path):
            if l.strip():
                o = json.loads(l); done[o["id"]] = o
    else:
        data = json.load(open(path))
        if isinstance(data, dict) and "items" in data:
            for it in data["items"]:
                done[it["id"]] = {"good": it.get("new_good"),
                                  "verdict": {"category": it.get("new_category")}}
    return done

def run_layer2(gold_dict, corpus, corpus_embeds):
    """edge / cloud それぞれ実RAG生成＋判定（逐次jsonl出力・再開可）"""
    edge_qs = [(gid, g) for gid, g in gold_dict.items()
               if g.get("expected") == "edge" and g.get("referencePoints")]
    print(f"\n=== layer 2: end-to-end (k={RETRIEVAL_K}) ===")
    print(f"対象: {len(edge_qs)}件 (edge想定)")

    for label, out_path, gen_fn in [
        ("edge", EDGE_OUT, gen_edge),
        ("cloud", CLOUD_OUT, gen_cloud),
    ]:
        done = load_existing(out_path)
        print(f"\n── {label} (model={'Gemma4 thinkOFF' if label=='edge' else CLOUD_MODEL}) ──")
        print(f"  既処理: {len(done)}件スキップ")

        with open(out_path, "a") as fout:
            for i, (gid, g) in enumerate(edge_qs):
                if gid in done:
                    continue
                top = retrieve(g["query"], corpus, corpus_embeds, RETRIEVAL_K)
                refs = [text for _, text, _ in top]
                ref_srcs = [s for s, _, _ in top]
                rec = {"id": gid, "query": g["query"], "expected": g.get("expected"),
                       "category": g.get("category"), "k": RETRIEVAL_K,
                       "retrieved_srcs": ref_srcs,
                       f"hit_src_id": gid in set(ref_srcs)}

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
                        rec["verdict"] = judge(g["query"], ans, refs)
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
# layer 3: 2x2 failure analysis + retrieval loss
# ═══════════════════════════════════════════

def layer3_analysis():
    """既存oracle結果と実RAG結果から2×2故障分離＋retrieval loss"""
    print("\n=== layer 3: 2x2 failure analysis ===")

    edge_oracle = load_existing(EDGE_ORACLE_P)
    cloud_oracle = load_existing(CLOUD_ORACLE_P)

    edge_real = load_existing(EDGE_OUT) if os.path.exists(EDGE_OUT) else {}
    cloud_real = load_existing(CLOUD_OUT) if os.path.exists(CLOUD_OUT) else {}

    common_ids = set(edge_oracle) & set(edge_real)
    print(f"共通id (edge): {len(common_ids)}")
    print(f"共通id (cloud): {len(set(cloud_oracle) & set(cloud_real))}")

    def two_by_two(oracle_dict, real_dict, label):
        """2x2表を作成。oracle_dict/real_dict は {id: {"good": bool}}"""
        ids = set(oracle_dict) & set(real_dict)
        oracle_good = 0
        retrieval_failure = 0
        reasoning_failure = 0
        both_ok = 0
        odd = 0

        for gid in sorted(ids):
            og = bool(oracle_dict[gid].get("good"))
            rg = bool(real_dict[gid].get("good"))

            if og:
                oracle_good += 1
                if rg:
                    both_ok += 1  # 検索も推論もOK
                else:
                    retrieval_failure += 1  # oracle goodだが実RAG bad → 検索律速
            else:
                if rg:
                    odd += 1  # oracle badだが実RAG good（稀）
                else:
                    reasoning_failure += 1  # oracleも実RAGもbad → 推論律速

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
        lines.append(f"- retrieval failure (検索で引けず劣化): {retrieval_failure}/{n} = {retrieval_failure/n*100:.1f}%")
        lines.append(f"- reasoning failure (モデル限界): {reasoning_failure}/{n} = {reasoning_failure/n*100:.1f}%")

        return {
            "label": label, "n": n,
            "oracle_good": oracle_good, "real_good": real_good,
            "both_ok": both_ok,
            "retrieval_failure": retrieval_failure,
            "reasoning_failure": reasoning_failure,
            "odd": odd,
            "lines": lines,
        }

    edge_result = two_by_two(edge_oracle, edge_real, "Edge (Gemma4 thinkOFF)")
    cloud_result = two_by_two(cloud_oracle, cloud_real, "Cloud (deepseek-v4-flash)")

    return edge_result, cloud_result


# ═══════════════════════════════════════════
# main
# ═══════════════════════════════════════════

def main():
    t0 = time.time()
    print(f"=== 実RAG MVP: k={RETRIEVAL_K} ===")
    print(f"SKIP_LAYER2={SKIP_LAYER2}")

    # layer 1
    gold_dict, corpus, corpus_embeds, recall_results, edge_qs = run_layer1()

    recall_lines = []
    recall_lines.append("\n## recall@k")
    recall_lines.append("")
    recall_lines.append("| k | recall |")
    recall_lines.append("|---|--------|")
    for k in sorted(recall_results):
        h, n = recall_results[k]
        recall_lines.append(f"| {k} | {h}/{n} = {h/n*100:.1f}% |")

    # layer 2
    if not SKIP_LAYER2:
        run_layer2(gold_dict, corpus, corpus_embeds)
    else:
        print("\n[layer2] skipped (SKIP_LAYER2=1)")

    # layer 3
    ed_r, cl_r = None, None
    edge_done = os.path.exists(EDGE_OUT)
    cloud_done = os.path.exists(CLOUD_OUT)
    if edge_done or cloud_done:
        ed_r, cl_r = layer3_analysis()
    else:
        print("\n[layer3] skipped: no real RAG output yet. run layer2 first.")

    # ── out/26 markdown ──
    elapsed = time.time() - t0
    md = []
    md.append("# 26: 実RAG MVP retrieval評価結果")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 構成")
    md.append(f"- corpus: {len(corpus)} chunks ({len(gold_dict)}質問の全referencePoints)")
    md.append(f"- embed: bge-m3 (ollama, dim=1024)")
    md.append(f"- 検索: cosine top-k (k={RETRIEVAL_K})")
    md.append(f"- edge model: Gemma4 26B thinkOFF (Workers AI)")
    md.append(f"- cloud model: {CLOUD_MODEL} (OpenCode)")
    md.append(f"- judge: {JUDGE_MODEL} (OpenRouter, 参照あり)")
    md.append(f"- 評価対象: edge想定41件")
    md.append("")

    md.extend(recall_lines)
    md.append("")

    if not SKIP_LAYER2:
        md.append("## retrieval 結果（生成用 k=5）")
        md.append("")
        if os.path.exists(EDGE_OUT):
            ed_rows = [json.loads(l) for l in open(EDGE_OUT) if l.strip()]
            ed_g = sum(1 for r in ed_rows if r.get("good"))
            ed_hit = sum(1 for r in ed_rows if r.get("hit_src_id"))
            md.append(f"- edge: {ed_g}/{len(ed_rows)} = {ed_g/len(ed_rows)*100:.1f}% good (hit rate={ed_hit}/{len(ed_rows)}={ed_hit/len(ed_rows)*100:.1f}%)")
        if os.path.exists(CLOUD_OUT):
            cl_rows = [json.loads(l) for l in open(CLOUD_OUT) if l.strip()]
            cl_g = sum(1 for r in cl_rows if r.get("good"))
            cl_hit = sum(1 for r in cl_rows if r.get("hit_src_id"))
            md.append(f"- cloud: {cl_g}/{len(cl_rows)} = {cl_g/len(cl_rows)*100:.1f}% good (hit rate={cl_hit}/{len(cl_rows)}={cl_hit/len(cl_rows)*100:.1f}%)")
        md.append("")

    if ed_r:
        md.extend(ed_r["lines"])
        md.append("")
    if cl_r:
        md.extend(cl_r["lines"])
        md.append("")

    md.append("## 考察")
    md.append("")
    if ed_r:
        md.append(f"- edge: oracle {ed_r['oracle_good']/ed_r['n']*100:.1f}% → 実RAG {ed_r['real_good']/ed_r['n']*100:.1f}% (retrieval loss={abs(ed_r['oracle_good']-ed_r['real_good'])/ed_r['n']*100:.1f}pts)")
        md.append(f"  - retrieval failure: {ed_r['retrieval_failure']}/{ed_r['n']} ({ed_r['retrieval_failure']/ed_r['n']*100:.1f}%)")
        md.append(f"  - reasoning failure: {ed_r['reasoning_failure']}/{ed_r['n']} ({ed_r['reasoning_failure']/ed_r['n']*100:.1f}%)")
    if cl_r:
        md.append(f"- cloud: oracle {cl_r['oracle_good']/cl_r['n']*100:.1f}% → 実RAG {cl_r['real_good']/cl_r['n']*100:.1f}% (retrieval loss={abs(cl_r['oracle_good']-cl_r['real_good'])/cl_r['n']*100:.1f}pts)")
        md.append(f"  - retrieval failure: {cl_r['retrieval_failure']}/{cl_r['n']} ({cl_r['retrieval_failure']/cl_r['n']*100:.1f}%)")
        md.append(f"  - reasoning failure: {cl_r['reasoning_failure']}/{cl_r['n']} ({cl_r['reasoning_failure']/cl_r['n']*100:.1f}%)")
    md.append("")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)


if __name__ == "__main__":
    main()
