#!/usr/bin/env python3
"""out/39: 全 gold-a 135件 V2生成 + tier再精査 2軸judge → 最終KPI確定
Phase 2: 修正 gold + refined tier で全領域の統合評価。
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
GEN_OUT      = os.path.join(DATA, "rag-mvp-cloud-qlevel-v2-all.jsonl")
RESULT_MD    = os.path.join(OUT, "39-final-kpi.md")

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


def load_existing_answers():
    """Load V2 answers from previous runs for reuse."""
    existing = {}
    for path in [
        os.path.join(DATA, "rag-mvp-easy-v2.jsonl"),
        os.path.join(DATA, "rag-mvp-cloud-calc-v2.jsonl"),
    ]:
        if os.path.exists(path):
            for line in open(path):
                if line.strip():
                    o = json.loads(line)
                    if not o.get("genFailed") and o.get("answer"):
                        existing[o["id"]] = o["answer"]
    return existing


def main():
    t0 = time.time()
    print(f"=== out/39: 全 gold-a 135件 統合評価 (最終KPI) ===")
    print(f"model: {CLOUD_MODEL} / judge: {JUDGE_MODEL} / prompt: V2 / tier: refined")

    gold_dict = load_gold()
    print(f"gold-a: {len(gold_dict)} questions")

    corpus = build_qlevel_corpus(gold_dict)
    corpus_embeds = embed_corpus_cf(corpus, NEW_CACHE)

    all_ids = sorted(gold_dict.keys())
    existing_answers = load_existing_answers()
    print(f"existing V2 answers: {len(existing_answers)}")

    done = set()
    if os.path.exists(GEN_OUT):
        for line in open(GEN_OUT):
            if line.strip():
                done.add(json.loads(line)["id"])
        print(f"  既処理スキップ: {len(done)}件")

    to_process = [gid for gid in all_ids if gid not in done]
    print(f"  要処理: {len(to_process)}件")
    n_total = len(all_ids)

    processed = len(done)
    with open(GEN_OUT, "a") as fout:
        for i, gid in enumerate(to_process):
            g = gold_dict[gid]

            top = search_top(g["query"], corpus, corpus_embeds, 1)
            src_id = top[0][0] if top else ""
            chunk_text = top[0][1] if top else ""
            gid_in_top = (src_id == gid)
            ref_lines = chunk_text.split("\n") if chunk_text else []

            rec = {"id": gid, "query": g["query"], "expected": g.get("expected"),
                   "category": g.get("category"), "top1_src_id": src_id,
                   "gid_in_top1": gid_in_top}

            # Use cached V2 answer if available
            ans = existing_answers.get(gid, "")
            if ans:
                rec["gen_source"] = "cache"
            else:
                t_gen = time.time()
                try:
                    ans = gen_cloud(g["query"], ref_lines)
                    rec["genFailed"] = False
                except Exception as ex:
                    ans = ""
                    rec["genFailed"] = True
                    rec["genError"] = str(ex)[:120]
                    print(f"  [{processed+1}/{n_total}] {gid} gen FAIL: {str(ex)[:80]}", flush=True)
                rec["latencyMs"] = int((time.time() - t_gen) * 1000)
                rec["gen_source"] = "new"
            rec["answer"] = ans

            # Judge with refined tiers
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
            gs = "G" if rec["good_strict"] else "."
            bc = classify_bad(rec) if not rec["good_relaxed"] else "-"
            v = rec["verdict"]
            gen_mark = "♻" if rec.get("gen_source") == "cache" else "●"
            if processed % 10 == 0 or i < 5:
                print(f"  [{processed}/{n_total}] {gid} relaxed={gr} strict={gs} "
                      f"bad={bc} {gen_mark} {v.get('reason','')[:40]}", flush=True)
            time.sleep(0.2)

    # Aggregate results
    rows = [json.loads(l) for l in open(GEN_OUT) if l.strip()]
    print(f"\n=== 集計 ({len(rows)}/{len(all_ids)} entries) ===")

    # Overall
    n = len(rows)
    good_r = sum(1 for r in rows if r.get("good_relaxed"))
    good_s = sum(1 for r in rows if r.get("good_strict"))
    factual_err = sum(1 for r in rows if not (r.get("verdict") or {}).get("factual"))
    overreach_n = sum(1 for r in rows if (r.get("verdict") or {}).get("overreach"))
    hit = sum(1 for r in rows if r.get("gid_in_top1"))

    bad_r = [r for r in rows if not r.get("good_relaxed")]
    bc = {"missing": 0, "misinterpreted": 0, "omitted": 0}
    for r in bad_r:
        bc[classify_bad(r)] += 1

    print(f"\n=== 最終 KPI (relaxed 正規) ===")
    print(f"relaxed good: {good_r}/{n} = **{good_r/n*100:.1f}%**")
    print(f"strict good: {good_s}/{n} = {good_s/n*100:.1f}%")
    print(f"top-1 hit: {hit}/{n} = {hit/n*100:.1f}%")
    print(f"factual: {factual_err}/{n}")
    print(f"overreach: {overreach_n}/{n}")
    print(f"bad 3分類: missing={bc['missing']} misinterpreted={bc['misinterpreted']} omitted={bc['omitted']}")

    # By category
    by_cat = {}
    for r in rows:
        cat = r.get("category", "other")
        by_cat.setdefault(cat, []).append(r)

    print(f"\n=== カテゴリ別 relaxed good ===")
    for cat in sorted(by_cat.keys()):
        cr = by_cat[cat]
        cn = len(cr)
        cg = sum(1 for r in cr if r.get("good_relaxed"))
        print(f"  {cat}: {cg}/{cn} = {cg/cn*100:.1f}%")

    # By expected
    by_exp = {}
    for r in rows:
        exp = r.get("expected", "?")
        by_exp.setdefault(exp, []).append(r)

    print(f"\n=== expected別 relaxed good ===")
    for exp in sorted(by_exp.keys()):
        er = by_exp[exp]
        en = len(er)
        eg = sum(1 for r in er if r.get("good_relaxed"))
        print(f"  {exp}: {eg}/{en} = {eg/en*100:.1f}%")

    # Write report
    elapsed = time.time() - t0
    md = []
    md.append("# 39: 全 gold-a 135件 統合評価 → 最終 KPI")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 背景")
    md.append("")
    md.append("- out/38: gold tier 再精査を恒久化（005/014 単位数降格）")
    md.append("- Phase 2: 修正 gold + refined tier + V2 prompt で全135件の統合 KPI を確定")
    md.append("- 本レポート: 運用判断のための経営指標")
    md.append("")
    md.append("## 構成")
    md.append("")
    md.append(f"- corpus: q-level {len(corpus)} chunks (全ref連結)")
    md.append(f"- embed: `@cf/baai/bge-m3` (Workers AI) — cache hit")
    md.append(f"- search: top-1 q-level chunk")
    md.append(f"- cloud gen: {CLOUD_MODEL} (OpenCode), prompt V2")
    md.append(f"- judge: {JUDGE_MODEL} (OpenRouter, temp=0, 2軸 refined tier)")
    md.append(f"- tier: _manual_supp={_manual_supp}")
    md.append("")

    md.append("## 最終 KPI")
    md.append("")
    md.append("| 指標 | 値 |")
    md.append("|---|---|")
    md.append(f"| **relaxed good（正規KPI）** | **{good_r}/{n} = {good_r/n*100:.1f}%** |")
    md.append(f"| strict good（副軸） | {good_s}/{n} = {good_s/n*100:.1f}% |")
    md.append(f"| top-1 gid hit率 | {hit}/{n} = {hit/n*100:.1f}% |")
    md.append(f"| factual誤り | {factual_err}/{n} = {factual_err/n*100:.1f}% |")
    md.append(f"| overreach | {overreach_n}/{n} |")
    md.append("")
    md.append("### bad 3分類")
    md.append("")
    md.append(f"| 分類 | 件数 | 割合 |")
    md.append(f"|---|---|---|")
    md.append(f"| missing (検索不hit) | {bc['missing']} | {bc['missing']/n*100:.1f}% |")
    md.append(f"| misinterpreted (factual誤り) | {bc['misinterpreted']} | {bc['misinterpreted']/n*100:.1f}% |")
    md.append(f"| omitted (hit & factual・回答不十分) | {bc['omitted']} | {bc['omitted']/n*100:.1f}% |")
    md.append(f"| **relaxed bad合計** | **{len(bad_r)}** | **{len(bad_r)/n*100:.1f}%** |")
    md.append("")

    md.append("## カテゴリ別 KPI")
    md.append("")
    md.append("| category | 件数 | relaxed good | strict good | top-1 hit |")
    md.append("|---|---|---|---|---|")
    for cat in sorted(by_cat.keys()):
        cr = by_cat[cat]
        cn = len(cr)
        cg_r = sum(1 for r in cr if r.get("good_relaxed"))
        cg_s = sum(1 for r in cr if r.get("good_strict"))
        c_hit = sum(1 for r in cr if r.get("gid_in_top1"))
        md.append(f"| {cat} | {cn} | {cg_r}/{cn} ({cg_r/cn*100:.0f}%) | {cg_s}/{cn} ({cg_s/cn*100:.0f}%) | {c_hit}/{cn} ({c_hit/cn*100:.0f}%) |")
    md.append("")

    md.append("## expected別 KPI")
    md.append("")
    md.append("| expected | 件数 | relaxed good | strict good | top-1 hit |")
    md.append("|---|---|---|---|---|")
    for exp in sorted(by_exp.keys()):
        er = by_exp[exp]
        en = len(er)
        eg_r = sum(1 for r in er if r.get("good_relaxed"))
        eg_s = sum(1 for r in er if r.get("good_strict"))
        e_hit = sum(1 for r in er if r.get("gid_in_top1"))
        md.append(f"| {exp} | {en} | {eg_r}/{en} ({eg_r/en*100:.0f}%) | {eg_s}/{en} ({eg_s/en*100:.0f}%) | {e_hit}/{en} ({e_hit/en*100:.0f}%) |")
    md.append("")

    md.append("## relaxed bad 一覧")
    md.append("")
    md.append("| id | category | expected | top1 hit | 3分類 | reason |")
    md.append("|---|---|---|---|---|---|")
    for r in sorted(bad_r, key=lambda x: x["id"]):
        v = r.get("verdict") or {}
        md.append(f"| {r['id']} | {r.get('category','')} | {r.get('expected','')} | "
                  f"{'Y' if r.get('gid_in_top1') else 'N'} | {classify_bad(r)} | {v.get('reason','')[:40]} |")
    md.append("")

    md.append("## 考察")
    md.append("")
    md.append(f"- **最終 relaxed KPI = {good_r/n*100:.1f}%**。一次対応アシスタントとしての実用性: {'高' if good_r/n*100 > 85 else '中'}")
    md.append(f"- retrieval は top-1 hit {hit/n*100:.1f}% で安定的に機能")
    md.append(f"- factual 誤り率 {factual_err/n*100:.1f}%: {'許容範囲内' if factual_err/n*100 < 3 else '要注意'}")
    md.append(f"- overreach = {overreach_n}: {'安全側' if overreach_n == 0 else '要確認'}")
    md.append(f"- 最大の残課題: omitted {bc['omitted']}件 = {bc['omitted']/n*100:.1f}%。{'generation改善で潰せる余地あり' if bc['omitted'] > bc['missing'] else 'retrieval改善が先'}")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)
    print(f"\n[DONE] elapsed={elapsed:.0f}s")


if __name__ == "__main__":
    main()
