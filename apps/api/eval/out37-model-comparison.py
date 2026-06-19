#!/usr/bin/env python3
"""out/37: calc-benefit 20件のモデル比較（DeepSeek Flash vs GPT-4o vs Claude Sonnet）
同一 retrieval・同一 prompt V2・同一 judge → generation capacity のモデル差を測定。
残存 omitted 3件(004/005/014)が他モデルで溶けるかを主指標とする。
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

ORK          = os.environ["OPENROUTER_API_KEY"]
OR_URL       = "https://openrouter.ai/api/v1/chat/completions"
JUDGE_MODEL  = os.environ.get("JUDGE_MODEL", "openai/gpt-4o")

GOLD_PATH    = os.path.join(DATA, "routing-gold-a.jsonl")
NEW_CACHE    = os.path.join(DATA, "rag-corpus-embeddings-qlevel-v2.json")
DSV2_JSONL   = os.path.join(DATA, "rag-mvp-cloud-calc-v2.jsonl")
GEN_OUT      = os.path.join(DATA, "rag-mvp-cloud-calc-modelcomp.jsonl")
RESULT_MD    = os.path.join(OUT, "37-model-comparison.md")

TARGET_IDS = [f"gold-calc-{i:03d}" for i in range(1, 21)]

MODELS = [
    ("deepseek-flash", "deepseek-v4-flash"),
    ("gpt-4o", "openai/gpt-4o"),
    ("claude-sonnet", "anthropic/claude-sonnet-4"),
]

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


def gen_via_opencode(query, refs):
    """DeepSeek Flash via OpenCode"""
    ref_text = "\n".join(f"- {pt}" for pt in refs)
    sys_p = EDGE_SYSTEM_PROMPT + f"\n\n回答の参考情報（介護保険の事実）:\n{ref_text}"
    r = requests.post(OPENCODE_URL,
                      headers={"Authorization": f"Bearer {OPENCODE_KEY}",
                               "Content-Type": "application/json"},
                      json={"model": "deepseek-v4-flash",
                            "messages": [{"role": "system", "content": sys_p},
                                         {"role": "user", "content": query}]},
                      timeout=120)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()


def gen_via_openrouter(query, refs, model):
    """GPT-4o / Claude Sonnet via OpenRouter"""
    ref_text = "\n".join(f"- {pt}" for pt in refs)
    sys_p = EDGE_SYSTEM_PROMPT + f"\n\n回答の参考情報（介護保険の事実）:\n{ref_text}"
    r = requests.post(OR_URL,
                      headers={"Authorization": f"Bearer {ORK}",
                               "Content-Type": "application/json"},
                      json={"model": model, "temperature": 0,
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
    print(f"=== out/37: calc-benefit モデル比較 (3 models × 20 questions) ===")
    print(f"models: {[m[0] for m in MODELS]}")
    print(f"judge: {JUDGE_MODEL} (全モデル共通)")

    gold_dict = load_gold()
    corpus = build_qlevel_corpus(gold_dict)
    print(f"q-level corpus: {len(corpus)} chunks")
    corpus_embeds = embed_corpus_cf(corpus, NEW_CACHE)

    target_qs = [(gid, gold_dict[gid]) for gid in TARGET_IDS if gid in gold_dict]
    print(f"対象: {len(target_qs)} questions\n")

    # Load existing entries
    existing = {}
    if os.path.exists(GEN_OUT):
        for line in open(GEN_OUT):
            if line.strip():
                o = json.loads(line)
                key = (o["id"], o["model"])
                existing[key] = o

    with open(GEN_OUT, "a") as fout:
        for mi, (model_label, model_id) in enumerate(MODELS):
            print(f"── {model_label} ({model_id}) ──")

            for i, (gid, g) in enumerate(target_qs):
                key = (gid, model_label)
                if key in existing:
                    print(f"  [{i+1}/{len(target_qs)}] {gid} skip (cached)")
                    continue

                top = search_top(g["query"], corpus, corpus_embeds, 1)
                src_id = top[0][0] if top else ""
                chunk_text = top[0][1] if top else ""
                gid_in_top = (src_id == gid)
                ref_lines = chunk_text.split("\n") if chunk_text else []

                rec = {"id": gid, "model": model_label, "query": g["query"],
                       "category": g.get("category"), "top1_src_id": src_id,
                       "gid_in_top1": gid_in_top}

                t_gen = time.time()
                try:
                    if model_label == "deepseek-flash":
                        ans = gen_via_opencode(g["query"], ref_lines)
                    else:
                        ans = gen_via_openrouter(g["query"], ref_lines, model_id)
                    rec["genFailed"] = False
                except Exception as ex:
                    ans = ""
                    rec["genFailed"] = True
                    rec["genError"] = str(ex)[:120]
                    print(f"  [{i+1}/{len(target_qs)}] {gid} gen FAIL: {str(ex)[:80]}", flush=True)
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

                gr = "G" if rec["good_relaxed"] else "."
                bc = classify_bad(rec) if not rec["good_relaxed"] else "-"
                v = rec["verdict"]
                print(f"  [{i+1}/{len(target_qs)}] {gid} relaxed={gr} bad={bc} "
                      f"{rec['latencyMs']}ms hit={'Y' if gid_in_top else 'N'} {v.get('reason','')[:40]}", flush=True)
                time.sleep(0.2)

    # Aggregate results
    rows = [json.loads(l) for l in open(GEN_OUT) if l.strip()]
    print(f"\n=== 集計 ({len(rows)} total entries) ===\n")

    model_results = {}
    for model_label, _ in MODELS:
        mrows = [r for r in rows if r["model"] == model_label]
        n = len(mrows)
        good_r = sum(1 for r in mrows if r.get("good_relaxed"))
        good_s = sum(1 for r in mrows if r.get("good_strict"))
        factual_err = sum(1 for r in mrows if not (r.get("verdict") or {}).get("factual"))
        overreach = sum(1 for r in mrows if (r.get("verdict") or {}).get("overreach"))

        bad_r = [r for r in mrows if not r.get("good_relaxed")]
        bc = {"missing": 0, "misinterpreted": 0, "omitted": 0}
        for r in bad_r:
            bc[classify_bad(r)] += 1

        hit = sum(1 for r in mrows if r.get("gid_in_top1"))

        model_results[model_label] = {
            "n": n, "good_r": good_r, "good_s": good_s,
            "factual_err": factual_err, "overreach": overreach,
            "bad_3": bc, "hit": hit, "rows": mrows,
        }

        print(f"{model_label}: relaxed={good_r}/{n}({good_r/n*100:.1f}%) "
              f"strict={good_s}/{n}({good_s/n*100:.1f}%) "
              f"factual={factual_err} overreach={overreach} "
              f"bad=missing{bc['missing']}/mis{bc['misinterpreted']}/omit{bc['omitted']}")

    # Per-item comparison for omitted 3 cases
    omitted_ids = ["gold-calc-004", "gold-calc-005", "gold-calc-014"]
    print(f"\n=== 残存 omitted 3件 モデル別比較 ===")
    print(f"{'id':<16} {'deepseek':>12} {'gpt-4o':>12} {'sonnet':>12}")
    for gid in omitted_ids:
        vals = []
        for ml, _ in MODELS:
            mrows = [r for r in rows if r["id"] == gid and r["model"] == ml]
            if mrows:
                r = mrows[0]
                gr = "G" if r.get("good_relaxed") else "."
                bc = classify_bad(r) if not r.get("good_relaxed") else "-"
                vals.append(f"{gr}({bc})")
            else:
                vals.append("?")
        print(f"{gid:<16} {vals[0]:>12} {vals[1]:>12} {vals[2]:>12}")

    # Write report
    elapsed = time.time() - t0
    md = []
    md.append("# 37: calc-benefit モデル比較 (DeepSeek Flash vs GPT-4o vs Claude Sonnet)")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 背景")
    md.append("")
    md.append("- out/35: prompt V2 で calc-benefit relaxed 55%→80%。3件 omitted が残存 (004/005/014)")
    md.append("- 仮説: 残存3件は generation capacity 天井（モデル限界）")
    md.append("- 本レポート: 同一条件で 3モデルを比較し、omitted がモデル差で溶けるか検証")
    md.append("")
    md.append("## 構成")
    md.append("")
    md.append(f"- retrieval: q-level top-1, 同一 corpus (135 chunks), 同一 chunk")
    md.append(f"- prompt: V2 (数値省略禁止・3〜5文) — 全モデル共通")
    md.append(f"- judge: {JUDGE_MODEL} (OpenRouter, temp=0, 2軸, 全ref=gold) — 全モデル共通")
    md.append(f"- 対象: {len(target_qs)}件 (calc-benefit 18 + boundary 2)")
    md.append("")
    md.append("## 結果")
    md.append("")
    md.append("| 指標 | deepseek-flash | gpt-4o | claude-sonnet |")
    md.append("|---|---|---|---|")
    for metric, key in [("relaxed good", "good_r"), ("strict good", "good_s"),
                         ("factual誤り", "factual_err"), ("overreach", "overreach"),
                         ("top-1 hit", "hit")]:
        vals = []
        for ml, _ in MODELS:
            mr = model_results[ml]
            if key in ("good_r", "good_s"):
                vals.append(f"{mr[key]}/20 = {mr[key]/20*100:.1f}%")
            else:
                vals.append(str(mr[key]))
        md.append(f"| {metric} | {vals[0]} | {vals[1]} | {vals[2]} |")
    md.append("")
    md.append("### bad 3分類")
    md.append("")
    md.append("| モデル | missing | misinterpreted | omitted | relaxed bad合計 |")
    md.append("|---|---|---|---|---|")
    for ml, _ in MODELS:
        bc = model_results[ml]["bad_3"]
        total_bad = sum(bc.values())
        md.append(f"| {ml} | {bc['missing']} | {bc['misinterpreted']} | {bc['omitted']} | {total_bad} |")
    md.append("")

    md.append("### 残存 omitted 3件 モデル別")
    md.append("")
    md.append("| id | deepseek | gpt-4o | sonnet | deepseek answer抜粋 |")
    md.append("|---|---|---|---|---|")
    for gid in omitted_ids:
        vals = []
        ds_ans = ""
        for ml, _ in MODELS:
            mrows = [r for r in rows if r["id"] == gid and r["model"] == ml]
            if mrows:
                r = mrows[0]
                v = r.get("verdict") or {}
                gr = "G" if r.get("good_relaxed") else "▪"
                bc = classify_bad(r) if not r.get("good_relaxed") else "-"
                vals.append(f"{gr} ({bc}) {v.get('reason','')[:20]}")
                if ml == "deepseek-flash":
                    ds_ans = r.get("answer", "")[:100]
            else:
                vals.append("?")
        md.append(f"| {gid} | {vals[0]} | {vals[1]} | {vals[2]} | {ds_ans} |")
    md.append("")

    md.append("## 考察")
    md.append("")
    ds_r = model_results["deepseek-flash"]["good_r"]
    best_label = max(MODELS, key=lambda m: model_results[m[0]]["good_r"])[0]
    best_r = model_results[best_label]["good_r"]

    if best_r > ds_r + 1:
        md.append(f"- **モデル差あり**: {best_label} が DeepSeek を +{best_r - ds_r}件 上回る。generation capacity が律速の一部")
        md.append(f"- → 本番モデルの {best_label} への変更を検討")
    else:
        md.append(f"- **モデル差ほぼなし**: 全モデルが relaxed {ds_r}/20 前後で横並び。generation capacity は全モデル共通の天井")
        md.append(f"- → 律速は generation policy でも capacity でもなく **gold 要求水準** の可能性が高い")
        md.append(f"- → gold tier 再精査（特に 014 の単位数/LIFE が main で妥当か）を推奨")

    md.append("")
    md.append(f"- deepseek baseline (out/35): relaxed 80.0%")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)
    print(f"\n[DONE] elapsed={elapsed:.0f}s")


if __name__ == "__main__":
    main()
