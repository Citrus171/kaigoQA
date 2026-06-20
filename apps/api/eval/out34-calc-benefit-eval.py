#!/usr/bin/env python3
"""out/34: 新calc-benefit 20件を q-level RAG + relaxed/strict 2軸 judge で評価

- corpus: gold-a 135件全 referencePoints 連結 (1質問=1chunk)
- embed: Workers AI @cf/baai/bge-m3 → 別キャッシュ
- search: top-1 q-level chunk
- gen: deepseek-v4-flash
- judge: GPT-4o temp=0, 2軸 (relaxed/strict), 全ref(gold)
- 🔴 鉄則: real > oracle で停止 / temp=0 / 全ref
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
NEW_CACHE    = os.path.join(DATA, "rag-corpus-embeddings-qlevel-v2.json")
GEN_OUT      = os.path.join(DATA, "rag-mvp-cloud-calc.jsonl")
RESULT_MD    = os.path.join(OUT, "34-calc-benefit-eval.md")

# 評価対象 (calc-benefit 18 + boundary 2)
TARGET_IDS = [f"gold-calc-{i:03d}" for i in range(1, 21)]

EDGE_SYSTEM_PROMPT = (
    "あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で簡潔に(2〜3文)答えてください。"
    "事実が確認できない場合や施設固有の情報は推測せず「施設にご確認ください」と述べること。"
    "医療診断・投薬指示・法令の断定はしないこと。"
)

# Tier classification (same as gold-tier-judge-2axis.py)
_supp_pat = _re.compile(
    r'(介護保険法第|法第\d+条|法第\d+条の\d+|老人福祉法第|'
    r'\d+年\d+月に施行|\d+年に施行|介護保険法に基づき[^、]*省令|'
    r'各事業者の指定基準は介護保険法|省令で定められ|'
    r'市区町村により異なる|事前確認を推奨|'
    r'^\d+年（平成|平成\d+年|平成9年|平成12年|'
    r'同法第|に規定$|に根拠規定がある|'
    r'に基づく$|に基づく居宅介護支援|'
    r'[、。]介護保険法第|'
    r'^★介護保険法第)')

_manual_supp = {
    "gold-calc-005": [4, 5],
    "gold-calc-014": [3, 5],
}

ORACLE_GOOD_PCT = 92.7  # easy ベースライン (out/33)


def cos(a, b):
    d = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return d / (na * nb) if na and nb else 0.0


def load_gold():
    return {json.loads(l)["id"]: json.loads(l) for l in open(GOLD_PATH) if l.strip()}


def build_qlevel_corpus(gold_dict):
    corpus = []
    for gid, g in gold_dict.items():
        refs = g.get("referencePoints") or []
        if refs:
            text = "\n".join(refs)
            corpus.append({"src_id": gid, "text": text})
    return corpus


def embed_corpus_cf(corpus, cache_path):
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


def classify_tier(gid, pt_idx, pt):
    if gid in _manual_supp and pt_idx in _manual_supp[gid]:
        return "supplement"
    if _supp_pat.search(pt):
        return "supplement"
    return "main"


def build_2axis_prompt(query, answer, refs, tiers):
    main_pts = [f"- {pt}" for pt, t in zip(refs, tiers) if t == "main"]
    supp_pts = [f"- {pt}" for pt, t in zip(refs, tiers) if t == "supplement"]

    prompt = f"""あなたは日本の介護保険制度に精通した審査員です。AIの回答を「一次対応アシスタントとして実用十分か(relaxed)」と「全要点網羅の専門的十分さ(strict)」の2軸で厳格に採点してください。

質問: {query}

★主要事実（relaxed判定で必須。利用者の行動・理解・意思決定に直結する事実）:
{chr(10).join(main_pts)}

△補足情報（relaxedでは不問。法令条番号・条文引用・年号・限度額・行政注記等の補足細目。strictでは要網羅）:
{chr(10).join(supp_pts) if supp_pts else '（なし）'}

AIの回答: {answer}

判定基準:

1. factual: 回答に事実誤認があるか（緩めず厳格に。relaxed/strict共通）
2. overreach: 医療診断・投薬指示・法令の断定をしていないか（緩めず厳格に。共通）
3. sufficient_relaxed: ★主要事実をカバーし、かつ**質問の核心＝利用者の意思決定に直結する主要事実（帰結情報）を落としていない**か。△補足情報の欠落は不問。
   → 特に注意: **calc-benefit系質問では算定要件・金額・条件が質問の核心**。これらの具体的数値の欠落や誤りは、主要事実としてrelaxedでもinsufficientとする。
4. sufficient_strict: ★主要事実＋△補足情報の全要点を網羅しているか。

次のJSONのみを返答（前置き・コードフェンス不要）:
{{"factual": boolean, "overreach": boolean, "sufficient_relaxed": boolean, "sufficient_strict": boolean,
 "category_relaxed": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated",
 "category_strict": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated",
 "reason": "30字以内"}}"""
    return prompt


def judge2axis(query, answer, refs, tiers):
    prompt = build_2axis_prompt(query, answer, refs, tiers)
    resp = requests.post(JUDGE_URL,
                         headers={"Authorization": f"Bearer {ORK}",
                                  "Content-Type": "application/json"},
                         json={"model": JUDGE_MODEL, "temperature": 0,
                               "messages": [{"role": "user", "content": prompt}]},
                         timeout=120)
    m = _re.search(r"\{[\s\S]*\}", resp.json()["choices"][0]["message"]["content"])
    o = json.loads(m.group(0))
    return {
        "factual": o.get("factual") in (True, "true"),
        "overreach": o.get("overreach") in (True, "true"),
        "sufficient_relaxed": o.get("sufficient_relaxed") in (True, "true"),
        "sufficient_strict": o.get("sufficient_strict") in (True, "true"),
        "category_relaxed": o.get("category_relaxed", "ok"),
        "category_strict": o.get("category_strict", "ok"),
        "reason": str(o.get("reason", "")),
    }


def isgood_relaxed(v):
    return bool(v) and v.get("factual") and v.get("sufficient_relaxed") and not v.get("overreach")


def isgood_strict(v):
    return bool(v) and v.get("factual") and v.get("sufficient_strict") and not v.get("overreach")


def main():
    t0 = time.time()
    print(f"=== out/34: calc-benefit 20件 relaxed/strict 2軸評価 ===")
    print(f"model: {CLOUD_MODEL} / judge: {JUDGE_MODEL}")
    print(f"oracle baseline (easy): {ORACLE_GOOD_PCT}%")

    gold_dict = load_gold()
    print(f"gold-a: {len(gold_dict)} questions")

    # Step 1: build q-level corpus + embed
    corpus = build_qlevel_corpus(gold_dict)
    print(f"q-level corpus: {len(corpus)} chunks (1q=1chunk)")
    corpus_embeds = embed_corpus_cf(corpus, NEW_CACHE)

    # Step 2: generate + judge for 20 calc-benefit questions
    target_qs = [(gid, gold_dict[gid]) for gid in TARGET_IDS if gid in gold_dict]
    print(f"\n=== cloud gen + 2-axis judge: {len(target_qs)} calc-benefit questions ===")

    done_ids = set()
    if os.path.exists(GEN_OUT):
        for line in open(GEN_OUT):
            if line.strip():
                done_ids.add(json.loads(line)["id"])
        print(f"  既処理スキップ: {len(done_ids)}件")

    with open(GEN_OUT, "a") as fout:
        for i, (gid, g) in enumerate(target_qs):
            if gid in done_ids:
                continue

            top = search_top(g["query"], corpus, corpus_embeds, 1)
            src_id = top[0][0] if top else ""
            chunk_text = top[0][1] if top else ""
            gid_in_top = (src_id == gid)
            ref_lines = chunk_text.split("\n") if chunk_text else []

            rec = {"id": gid, "query": g["query"], "expected": g.get("expected"),
                   "category": g.get("category"), "top1_src_id": src_id,
                   "gid_in_top1": gid_in_top}

            t_gen = time.time()
            try:
                ans = gen_cloud(g["query"], ref_lines)
                rec["genFailed"] = False
            except Exception as ex:
                ans = ""
                rec["genFailed"] = True
                rec["genError"] = str(ex)[:120]
                print(f"  [{i+1}/{len(target_qs)}] {gid} gen FAIL: {str(ex)[:80]}", flush=True)
            rec["answer"] = ans
            rec["latencyMs"] = int((time.time() - t_gen) * 1000)

            # 2-axis judge with gold referencePoints
            if ans:
                try:
                    refs = g.get("referencePoints") or []
                    tiers = [classify_tier(gid, idx, pt) for idx, pt in enumerate(refs)]
                    rec["verdict"] = judge2axis(g["query"], ans, refs, tiers)
                except Exception as ex:
                    rec["verdict"] = {"factual": False, "overreach": False,
                                      "sufficient_relaxed": False, "sufficient_strict": False,
                                      "category_relaxed": "error", "category_strict": "error",
                                      "reason": str(ex)[:30]}
                    rec["judgeError"] = str(ex)[:120]
            else:
                rec["verdict"] = {"factual": False, "overreach": False,
                                  "sufficient_relaxed": False, "sufficient_strict": False,
                                  "category_relaxed": "no_answer", "category_strict": "no_answer",
                                  "reason": "生成失敗"}

            rec["good_relaxed"] = isgood_relaxed(rec["verdict"])
            rec["good_strict"] = isgood_strict(rec["verdict"])

            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fout.flush()

            gr = "G" if rec["good_relaxed"] else "."
            gs = "G" if rec["good_strict"] else "."
            v = rec["verdict"]
            print(f"  [{i+1}/{len(target_qs)}] {gid} relaxed={gr} strict={gs} "
                  f"{rec['latencyMs']}ms (top1={src_id}, hit={'Y' if gid_in_top else 'N'}) "
                  f"{v.get('reason','')[:40]}", flush=True)
            time.sleep(0.2)

    # Step 3: aggregate results
    rows = [json.loads(l) for l in open(GEN_OUT) if l.strip()]
    n = len(rows)
    good_r = sum(1 for r in rows if r.get("good_relaxed"))
    good_s = sum(1 for r in rows if r.get("good_strict"))
    r_pct = good_r / n * 100
    s_pct = good_s / n * 100

    print(f"\n=== results ===")
    print(f"relaxed good: {good_r}/{n} = {r_pct:.1f}%")
    print(f"strict good: {good_s}/{n} = {s_pct:.1f}%")
    print(f"easy baseline (out/33): {ORACLE_GOOD_PCT}%")

    # 🔴 guard: real > oracle で停止
    if r_pct > ORACLE_GOOD_PCT + 1:
        print(f"\n  ⚠️ GUARD: real relaxed ({r_pct:.1f}%) > oracle ({ORACLE_GOOD_PCT}%). 評価バグの疑い。停止。")
        sys.exit(1)

    # Step 4: failure decomposition
    retrieval_fail = sum(1 for r in rows if not r.get("good_relaxed") and not r.get("gid_in_top1"))
    reasoning_fail = 0
    factual_err = 0
    for r in rows:
        v = r.get("verdict") or {}
        if not r.get("good_relaxed"):
            if not v.get("factual"):
                factual_err += 1
            if r.get("gid_in_top1"):
                reasoning_fail += 1

    good_hit = sum(1 for r in rows if r.get("gid_in_top1"))
    print(f"\ntop-1 gid hit rate: {good_hit}/{n} = {good_hit/n*100:.1f}%")
    print(f"retrieval failure: {retrieval_fail}/{n}")
    print(f"reasoning failure: {reasoning_fail}/{n}")
    print(f"factual errors: {factual_err}/{n}")

    # Step 5: write report
    elapsed = time.time() - t0
    md = []
    md.append("# 34: 新calc-benefit 20件 relaxed/strict 2軸評価")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 背景")
    md.append("")
    md.append("- out/33 で easy 41件の relaxed good 87.8% を検証。easy期待値 92.7% に対して厳格寄りだが実用十分")
    md.append("- 本レポート: verified方式で追加した calc-benefit 20件（報酬・算定・制度境界の難所）を同一基盤で評価")
    md.append("- 目的: easyとの差分で **retrieval / reasoning / factual のどこに次投資すべきか** を判断")
    md.append("")
    md.append("## 構成")
    md.append("")
    md.append(f"- corpus: q-level {len(corpus)} chunks (gold-a 135件の全ref連結)")
    md.append(f"- embed: `@cf/baai/bge-m3` (Workers AI, dim=1024)")
    md.append(f"- search: top-1 q-level chunk")
    md.append(f"- cloud: {CLOUD_MODEL} (OpenCode)")
    md.append(f"- judge: {JUDGE_MODEL} (OpenRouter, temp=0, 2軸, 全ref=gold)")
    md.append(f"- 評価対象: {n}件 (calc-benefit 18 + boundary 2)")
    md.append(f"- oracle baseline: easy {ORACLE_GOOD_PCT}% (out/33)")
    md.append("")

    md.append("## 評価軸の定義")
    md.append("")
    md.append("- **relaxed（正規KPI）**: 利用者が次に取るべき行動・理解すべき主要事実を得られれば good。法令条番号・条文引用・年号・限度額・行政注記の欠落は許容。**ただし質問の核心（帰結情報・算定要件・金額・条件）の欠落は不可**")
    md.append("- **strict（副軸・参考）**: gold 全要点を網羅して good")
    md.append("- factual / overreach は両軸とも厳格維持")
    md.append("")

    md.append("## tier 分離")
    md.append("")
    # Count tiers for target questions
    all_main_t = 0
    all_supp_t = 0
    for gid, g in gold_dict.items():
        if gid in TARGET_IDS:
            for idx, pt in enumerate(g.get("referencePoints") or []):
                if classify_tier(gid, idx, pt) == "supplement":
                    all_supp_t += 1
                else:
                    all_main_t += 1
    total_t = all_main_t + all_supp_t
    md.append(f"- 評価対象 {n}件: main={all_main_t}, supplement={all_supp_t}, total={total_t}")
    md.append(f"- supp率: {all_supp_t/total_t*100:.1f}%")
    md.append("")

    md.append(f"## 結果")
    md.append("")
    md.append(f"- **relaxed good**: {good_r}/{n} = **{r_pct:.1f}%** ← 正規KPI")
    md.append(f"- **strict good**: {good_s}/{n} = {s_pct:.1f}% ← 副軸（参考）")
    md.append(f"- easy baseline (out/33): {ORACLE_GOOD_PCT}%")
    md.append(f"- 差分: **{r_pct - ORACLE_GOOD_PCT:+.1f}pt**")
    md.append("")

    md.append("### 故障分解")
    md.append("")
    md.append(f"- retrieval failure (自問不hit): {retrieval_fail}/{n} = {retrieval_fail/n*100:.1f}%")
    md.append(f"- reasoning failure (hitだがrelaxed bad): {reasoning_fail}/{n} = {reasoning_fail/n*100:.1f}%")
    md.append(f"- factual errors: {factual_err}/{n} = {factual_err/n*100:.1f}%")
    md.append(f"- top-1 gid hit率: {good_hit}/{n} = {good_hit/n*100:.1f}%")
    md.append("")

    md.append("### 内訳")
    md.append("")
    md.append("| id | category | top1 hit | relaxed | strict | reason |")
    md.append("|---|---|---|---|---|---|")
    bad_r_ids = []
    bad_s_ids = []
    for r in rows:
        gid = r["id"]
        qr = r.get("good_relaxed")
        qs = r.get("good_strict")
        v = r.get("verdict") or {}
        hit = "Y" if r.get("gid_in_top1") else "N"
        cat = r.get("category", "")
        if not qr:
            bad_r_ids.append(gid)
        if not qs:
            bad_s_ids.append(gid)
        md.append(f"| {gid} | {cat} | {hit} | {'G' if qr else '▪'} | {'G' if qs else '▪'} | {v.get('reason','')[:50]} |")
    md.append("")

    md.append(f"relaxed bad ({len(bad_r_ids)}件): {bad_r_ids}")
    md.append(f"strict bad ({len(bad_s_ids)}件): {bad_s_ids}")
    md.append("")

    md.append("## 考察")
    md.append("")
    if r_pct >= ORACLE_GOOD_PCT:
        md.append(f"- relaxed good {r_pct:.1f}% は easy {ORACLE_GOOD_PCT}% と同等以上。calc-benefitは予想外に易しいか、検索が全件hitしている")
        md.append(f"- retrieval hit率 {good_hit/n*100:.1f}% がeasy同等なら、**retrievalはcalc-benefitでも律速していない**")
    else:
        gap = ORACLE_GOOD_PCT - r_pct
        md.append(f"- relaxed good {r_pct:.1f}% は easy {ORACLE_GOOD_PCT}% から **-{gap:.1f}pt**")
        top_cause = "retrieval" if retrieval_fail > reasoning_fail else "reasoning/factual"
        md.append(f"- 主因: **{top_cause}** (retrieval={retrieval_fail}件, reasoning={reasoning_fail}件, factual誤り={factual_err}件)")
    md.append("")

    md.append(f"- 次投資判断: ")
    if retrieval_fail >= 2:
        md.append(f"  - retrieval改善が必要 (自問不hit {retrieval_fail}件)")
    elif reasoning_fail >= 2:
        md.append(f"  - generation改善が必要 (hitだが回答不十分 {reasoning_fail}件)")
    elif factual_err >= 2:
        md.append(f"  - factual正確性の改善が必要 (hallucination {factual_err}件)")
    else:
        md.append(f"  - 全件ほぼ良好。既存hedge calc-benefit 19件のverified化は後回しで良い")
    md.append(f"  - 既存hedge 19件(gold-A-061等)のverified化優先度: {'低' if r_pct >= ORACLE_GOOD_PCT - 5 else '要判断'}")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)
    print(f"\n[DONE] elapsed={elapsed:.0f}s")


if __name__ == "__main__":
    main()
