#!/usr/bin/env python3
"""out/41: top-3 q-level RAG 全135件再評価
Sprint 1: top-3 採用で retrieval missing 10件回収を実測。希釈による既存 good 悪化も監視。
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
OR_URL       = "https://openrouter.ai/api/v1/chat/completions"
JUDGE_MODEL  = os.environ.get("JUDGE_MODEL", "openai/gpt-4o")

GOLD_PATH    = os.path.join(DATA, "routing-gold-a.jsonl")
NEW_CACHE    = os.path.join(DATA, "rag-corpus-embeddings-qlevel-v2.json")
OUT39_JSONL  = os.path.join(DATA, "rag-mvp-cloud-qlevel-v2-all.jsonl")
GEN_OUT      = os.path.join(DATA, "rag-mvp-cloud-qlevel-v2-top3.jsonl")
RESULT_MD    = os.path.join(OUT, "41-top3-evaluation.md")

EDGE_SYSTEM_PROMPT = (
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

RETRIEVAL_K = 3


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
    raise RuntimeError(f"cache not found: {cache_path}")


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


def gen_cloud(query, ref_texts):
    """top-k chunks を連結してシステムプロンプトに注入"""
    combined = "\n\n".join(ref_texts)
    sys_p = EDGE_SYSTEM_PROMPT + f"\n\n回答の参考情報（介護保険の事実）:\n{combined}"
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
    resp = requests.post(OR_URL,
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


def classify_bad(r):
    if not r.get("gid_in_top1"):
        return "missing"
    v = r.get("verdict") or {}
    if not v.get("factual"):
        return "misinterpreted"
    return "omitted"


def main():
    t0 = time.time()
    print(f"=== out/41: top-3 q-level RAG 全135件再評価 ===")
    print(f"k={RETRIEVAL_K} / model: {CLOUD_MODEL} / judge: {JUDGE_MODEL}")

    gold_dict = load_gold()
    corpus = build_qlevel_corpus(gold_dict)
    corpus_embeds = embed_corpus_cf(corpus, NEW_CACHE)

    all_ids = sorted(gold_dict.keys())

    done = set()
    if os.path.exists(GEN_OUT):
        for line in open(GEN_OUT):
            if line.strip():
                done.add(json.loads(line)["id"])
        print(f"  既処理: {len(done)}件")

    to_process = [gid for gid in all_ids if gid not in done]
    print(f"  要処理: {len(to_process)}/{len(all_ids)}件")
    n_total = len(all_ids)
    processed = len(done)

    with open(GEN_OUT, "a") as fout:
        for i, gid in enumerate(to_process):
            g = gold_dict[gid]

            top = search_top(g["query"], corpus, corpus_embeds, RETRIEVAL_K)
            top_ids = [t[0] for t in top]
            gid_in_top1 = (top_ids[0] == gid)
            gid_in_topk = (gid in top_ids)
            ref_texts = [t[1] for t in top]

            rec = {"id": gid, "query": g["query"], "expected": g.get("expected"),
                   "category": g.get("category"), "k": RETRIEVAL_K,
                   "top_ids": top_ids,
                   "gid_in_top1": gid_in_top1, "gid_in_topk": gid_in_topk}

            t_gen = time.time()
            try:
                ans = gen_cloud(g["query"], ref_texts)
                rec["genFailed"] = False
            except Exception as ex:
                ans = ""
                rec["genFailed"] = True
                rec["genError"] = str(ex)[:120]
                print(f"  [{processed+1}/{n_total}] {gid} gen FAIL: {str(ex)[:80]}", flush=True)
            rec["answer"] = ans
            rec["latencyMs"] = int((time.time() - t_gen) * 1000)

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

            processed += 1
            gr = "G" if rec["good_relaxed"] else "."
            bc = classify_bad(rec) if not rec["good_relaxed"] else "-"
            v = rec["verdict"]
            if processed % 10 == 0 or i < 5:
                hit_mark = "H" if gid_in_topk else "M"
                print(f"  [{processed}/{n_total}] {gid} relaxed={gr} bad={bc} {hit_mark} "
                      f"{v.get('reason','')[:40]}", flush=True)
            time.sleep(0.2)

    # Aggregate + diff
    rows41 = [json.loads(l) for l in open(GEN_OUT) if l.strip()]
    rows39 = {r["id"]: r for r in (json.loads(l) for l in open(OUT39_JSONL) if l.strip())}

    n = len(rows41)
    good_r = sum(1 for r in rows41 if r.get("good_relaxed"))
    good_s = sum(1 for r in rows41 if r.get("good_strict"))
    factual_err = sum(1 for r in rows41 if not (r.get("verdict") or {}).get("factual"))
    overreach_n = sum(1 for r in rows41 if (r.get("verdict") or {}).get("overreach"))
    hit_k = sum(1 for r in rows41 if r.get("gid_in_topk"))
    hit_1 = sum(1 for r in rows41 if r.get("gid_in_top1"))

    bad_r = [r for r in rows41 if not r.get("good_relaxed")]
    bc = {"missing": 0, "misinterpreted": 0, "omitted": 0}
    for r in bad_r:
        bc[classify_bad(r)] += 1

    # Diff: per-item comparison
    improved = []
    regressed = []
    kept_good = []
    kept_bad = []
    for r41 in rows41:
        gid = r41["id"]
        r39 = rows39.get(gid, {})
        r39g = r39.get("good_relaxed", False)
        r41g = r41.get("good_relaxed")
        if r41g and not r39g:
            improved.append(gid)
        elif r39g and not r41g:
            regressed.append(gid)
        elif r41g and r39g:
            kept_good.append(gid)
        else:
            kept_bad.append(gid)

    print(f"\n=== results ===")
    print(f"relaxed: {good_r}/{n} = {good_r/n*100:.1f}% (top-1: {sum(1 for r in rows39.values() if r.get('good_relaxed'))}/{len(rows39)})")
    print(f"strict: {good_s}/{n} = {good_s/n*100:.1f}%")
    print(f"hit: top-1={hit_1} top-{RETRIEVAL_K}={hit_k}")
    print(f"diff: improved={len(improved)} regressed={len(regressed)} kept_good={len(kept_good)} kept_bad={len(kept_bad)}")

    elapsed = time.time() - t0

    # Write report
    out39_good_r = sum(1 for r in rows39.values() if r.get("good_relaxed"))
    out39_hit = sum(1 for r in rows39.values() if r.get("gid_in_top1"))
    md = []
    md.append("# 41: top-3 q-level RAG 全135件再評価")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 背景")
    md.append("- out/40: missing 13件中 top-3 で 10件回収可能と判明")
    md.append("- 本レポート: top-3 を実採用し relaxed 増分を実測。希釈による既存 good 悪化も監視")
    md.append("")
    md.append("## 結果")
    md.append("")
    md.append("| 指標 | out/39 (top-1) | out/41 (top-3) | 差分 |")
    md.append("|---|---|---|---|")
    md.append(f"| relaxed good | {out39_good_r}/135 = {out39_good_r/135*100:.1f}% | {good_r}/135 = **{good_r/135*100:.1f}%** | {good_r - out39_good_r:+d}件 ({good_r/135*100 - out39_good_r/135*100:+.1f}pt) |")
    md.append(f"| strict good | {sum(1 for r in rows39.values() if r.get('good_strict'))}/135 | {good_s}/135 | — |")
    md.append(f"| top-k gid hit | {out39_hit}/135 ({out39_hit/135*100:.0f}%) | {hit_k}/135 ({hit_k/135*100:.0f}%) | {hit_k-out39_hit:+d} |")
    md.append(f"| factual誤り | {sum(1 for r in rows39.values() if not (r.get('verdict')or{}).get('factual'))}/135 | {factual_err}/135 | — |")
    md.append(f"| overreach | 0 | {overreach_n} | — |")
    md.append("")
    md.append("### diff 分析")
    md.append("")
    md.append(f"| 変化 | 件数 |")
    md.append(f"|---|---|")
    md.append(f"| ↑改善 (bad→good) | {len(improved)} |")
    md.append(f"| ↓悪化 (good→bad) | {len(regressed)} |")
    md.append(f"| =good (good→good) | {len(kept_good)} |")
    md.append(f"| =bad (bad→bad) | {len(kept_bad)} |")
    md.append("")

    if improved:
        md.append("### 改善 (top-1 missing → top-3 good)")
        md.append("")
        md.append("| id | category | top-1 hit | top-3 hit | reason |")
        md.append("|---|---|---|---|---|")
        for gid in improved:
            r41 = next(r for r in rows41 if r["id"] == gid)
            r39 = rows39.get(gid, {})
            v = r41.get("verdict") or {}
            md.append(f"| {gid} | {r41.get('category','')} | "
                      f"{'Y' if r39.get('gid_in_top1') else 'N'} | {'Y' if r41.get('gid_in_topk') else 'N'} | "
                      f"{v.get('reason','')[:35]} |")
        md.append("")

    if regressed:
        md.append("### 悪化 (top-1 good → top-3 bad) ⚠️")
        md.append("")
        md.append("| id | category | reason |")
        md.append("|---|---|---|")
        for gid in regressed:
            r41 = next(r for r in rows41 if r["id"] == gid)
            v = r41.get("verdict") or {}
            md.append(f"| {gid} | {r41.get('category','')} | {v.get('reason','')[:50]} |")
        md.append("")

    if kept_bad:
        md.append("### 不変bad (top-1 bad → top-3 bad)")
        md.append("")
        md.append("| id | category | reason |")
        md.append("|---|---|---|")
        for gid in kept_bad:
            r41 = next(r for r in rows41 if r["id"] == gid)
            v = r41.get("verdict") or {}
            md.append(f"| {gid} | {r41.get('category','')} | {v.get('reason','')[:40]} |")
        md.append("")

    md.append("## 考察")
    md.append("")
    if len(regressed) == 0 and len(improved) >= 5:
        md.append(f"- **top-3 は有効かつ安全**: {len(improved)}件改善、回帰0件。relaxed {good_r/135*100:.1f}%")
        md.append(f"- → top-3 を本番採用可能。希釈による悪化は観測されず")
    elif len(regressed) > 0 and len(improved) > len(regressed):
        net = len(improved) - len(regressed)
        md.append(f"- **top-3 は有効だが回帰あり**: 改善{len(improved)}件 − 悪化{len(regressed)}件 = net +{net}件")
        md.append(f"- 悪化id: {regressed} — 希釈原因を精査し個別対応を検討")
    else:
        md.append(f"- **top-3 の効果は限定的**: 改善{len(improved)}件、悪化{len(regressed)}件")

    md.append(f"- out/40 予測: top-3 で 10件回収可能 → 実測 {len(improved)}件 (予測比 {len(improved)/10*100:.0f}%)")
    md.append("")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)
    print(f"\n[DONE] elapsed={elapsed:.0f}s")


if __name__ == "__main__":
    main()
