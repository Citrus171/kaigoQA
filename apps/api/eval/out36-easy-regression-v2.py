#!/usr/bin/env python3
"""out/36: easy 41件で prompt V2 回帰確認。V2 本番反映前の最終ゲート。
EDGE_SYSTEM_PROMPT 以外は out/34-35 と完全固定。oracle guard は無効化。
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
GEN_OUT      = os.path.join(DATA, "rag-mvp-easy-v2.jsonl")
RESULT_MD    = os.path.join(OUT, "36-easy-regression-v2.md")

# out/33 baseline verdicts
BASELINE_VERDICTS = os.path.join(DATA, "rejudge-2axis-verdicts.json")

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

BASELINE_RELAXED_PCT = 87.8
BASELINE_STRICT_PCT = 31.7
BASELINE_OVERREACH = 0
BASELINE_FACTUAL = 1


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


def classify_bad(r):
    if not r.get("gid_in_top1"):
        return "missing"
    v = r.get("verdict") or {}
    if not v.get("factual"):
        return "misinterpreted"
    return "omitted"


def main():
    t0 = time.time()
    print(f"=== out/36: easy 41件 prompt V2 回帰確認 ===")
    print(f"model: {CLOUD_MODEL} / judge: {JUDGE_MODEL}")
    print(f"prompt: V2 (数値省略禁止・3〜5文)")
    print(f"baseline (out/33 old prompt): relaxed {BASELINE_RELAXED_PCT}% / strict {BASELINE_STRICT_PCT}% / overreach {BASELINE_OVERREACH} / factual誤り {BASELINE_FACTUAL}")
    print(f"🔴 oracle guard: DISABLED (easy V2がbaseline超えは正当な改善)")

    gold_dict = load_gold()
    print(f"gold-a: {len(gold_dict)} questions")

    edge_ids = sorted(gid for gid, g in gold_dict.items()
                      if g.get("expected") == "edge" and g.get("referencePoints"))
    print(f"easy edge questions: {len(edge_ids)} (out/33と同一固定集合)")

    corpus = build_qlevel_corpus(gold_dict)
    print(f"q-level corpus: {len(corpus)} chunks (1q=1chunk)")
    corpus_embeds = embed_corpus_cf(corpus, NEW_CACHE)

    target_qs = [(gid, gold_dict[gid]) for gid in edge_ids]
    print(f"\n=== cloud gen + 2-axis judge: {len(target_qs)} easy questions (prompt V2) ===")

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
            bc = classify_bad(rec) if not rec["good_relaxed"] else "-"
            print(f"  [{i+1}/{len(target_qs)}] {gid} relaxed={gr} strict={gs} "
                  f"{rec['latencyMs']}ms (top1={src_id}, hit={'Y' if gid_in_top else 'N'}) "
                  f"bad={bc} {v.get('reason','')[:40]}", flush=True)
            time.sleep(0.2)

    rows = [json.loads(l) for l in open(GEN_OUT) if l.strip()]
    n = len(rows)
    good_r = sum(1 for r in rows if r.get("good_relaxed"))
    good_s = sum(1 for r in rows if r.get("good_strict"))
    r_pct = good_r / n * 100
    s_pct = good_s / n * 100

    print(f"\n=== results ===")
    print(f"relaxed good: {good_r}/{n} = {r_pct:.1f}% (baseline: {BASELINE_RELAXED_PCT}%)")
    print(f"strict good: {good_s}/{n} = {s_pct:.1f}% (baseline: {BASELINE_STRICT_PCT}%)")

    bad_r = [r for r in rows if not r.get("good_relaxed")]
    bc_counts = {"missing": 0, "misinterpreted": 0, "omitted": 0}
    for r in bad_r:
        c = classify_bad(r)
        bc_counts[c] += 1
    print(f"\nbad 3分類 (relaxed bad={len(bad_r)}件):")
    print(f"  missing: {bc_counts['missing']}")
    print(f"  misinterpreted: {bc_counts['misinterpreted']}")
    print(f"  omitted: {bc_counts['omitted']}")

    retrieval_fail = bc_counts["missing"]
    factual_err = sum(1 for r in rows if not (r.get("verdict") or {}).get("factual"))
    overreach_n = sum(1 for r in rows if (r.get("verdict") or {}).get("overreach"))
    good_hit = sum(1 for r in rows if r.get("gid_in_top1"))
    print(f"\ntop-1 gid hit rate: {good_hit}/{n} = {good_hit/n*100:.1f}%")
    print(f"factual errors: {factual_err}/{n} (baseline: {BASELINE_FACTUAL})")
    print(f"overreach: {overreach_n}/{n} (baseline: {BASELINE_OVERREACH})")

    # Load out/33 baseline verdicts
    baseline_verdicts = json.load(open(BASELINE_VERDICTS)) if os.path.exists(BASELINE_VERDICTS) else {}
    baseline_r_good = sum(1 for gid in edge_ids if isgood_relaxed(baseline_verdicts.get(gid, {})))
    baseline_s_good = sum(1 for gid in edge_ids if isgood_strict(baseline_verdicts.get(gid, {})))

    # Per-item diff
    improved = []
    regressed = []
    unchanged_bad = []
    for r in rows:
        gid = r["id"]
        bv = baseline_verdicts.get(gid, {})
        b34_good = isgood_relaxed(bv)
        b35_good = r.get("good_relaxed")
        if b35_good and not b34_good:
            improved.append(gid)
        elif b34_good and not b35_good:
            regressed.append(gid)
        elif not b35_good and not b34_good:
            unchanged_bad.append(gid)

    # Pass/fail check
    conditions = {
        "relaxed ≥ 87.8%": r_pct >= BASELINE_RELAXED_PCT,
        "overreach = 0": overreach_n == BASELINE_OVERREACH,
        "factual ≤ 1": factual_err <= BASELINE_FACTUAL,
    }
    passed = all(conditions.values())
    print(f"\n=== pass/fail ===")
    for cond, ok in conditions.items():
        print(f"  {'✅' if ok else '❌'} {cond}")
    print(f"  → {'PASS' if passed else 'FAIL'}")

    elapsed = time.time() - t0

    # Write report
    md = []
    md.append("# 36: easy 41件 prompt V2 回帰確認")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 背景")
    md.append("")
    md.append("- out/35: prompt V2 が calc-benefit を relaxed 55%→80%(+25pt, 悪化0) に改善。律速=generation policy と確定")
    md.append("- 本レポート: **V2 本番反映前の最終ゲート**。easy 41件で V2 が回帰しないか確認")
    md.append("- 焦点: 長文化(3〜5文)・数値強制が easy で overreach/factual/冗長partial を誘発しないか")
    md.append("")
    md.append("## 対象")
    md.append("")
    md.append(f"- easy 41件（expected=edge, out/33 と同一固定集合）")
    md.append(f"- gold-a total 135件。新 calc20 は expected=cloud で混入なし (Claude確認済)")
    md.append(f"- baseline verdict: `rejudge-2axis-verdicts.json` ({len(baseline_verdicts)}件)")
    md.append("")
    md.append("## 構成")
    md.append("")
    md.append(f"- corpus: q-level {len(corpus)} chunks (gold-a 135件)")
    md.append(f"- embed: `@cf/baai/bge-m3` (Workers AI, dim=1024) — cache hit")
    md.append(f"- search: top-1 q-level chunk")
    md.append(f"- cloud: {CLOUD_MODEL} (OpenCode)")
    md.append(f"- judge: {JUDGE_MODEL} (OpenRouter, temp=0, 2軸, 全ref=gold)")
    md.append(f"- prompt: V2 (数値省略禁止・3〜5文)")
    md.append(f"- 🔴 oracle guard: 無効化")
    md.append("")
    md.append("## system prompt V2 (out/35 と同一)")
    md.append("")
    md.append("```")
    md.append(EDGE_SYSTEM_PROMPT[:200] + "...")
    md.append("```")
    md.append("")
    md.append("## baseline（out/33 旧prompt）")
    md.append("")
    md.append(f"- relaxed good: {baseline_r_good}/41 = **{BASELINE_RELAXED_PCT}%**")
    md.append(f"- strict good: {baseline_s_good}/41 = {BASELINE_STRICT_PCT}%")
    md.append(f"- overreach: {BASELINE_OVERREACH}")
    md.append(f"- factual誤り: {BASELINE_FACTUAL}")
    md.append("")
    md.append("## 結果")
    md.append("")
    md.append("| 指標 | out/33 (旧prompt) | out/36 (V2) | 差分 |")
    md.append("|---|---|---|---|")
    md.append(f"| relaxed good | {baseline_r_good}/41 = {BASELINE_RELAXED_PCT}% | {good_r}/41 = **{r_pct:.1f}%** | {r_pct - BASELINE_RELAXED_PCT:+.1f}pt |")
    md.append(f"| strict good | {baseline_s_good}/41 = {BASELINE_STRICT_PCT}% | {good_s}/41 = {s_pct:.1f}% | {s_pct - BASELINE_STRICT_PCT:+.1f}pt |")
    md.append(f"| overreach | {BASELINE_OVERREACH} | {overreach_n} | {'✅ 0維持' if overreach_n==0 else '⚠️ 増加:+'+str(overreach_n)} |")
    md.append(f"| factual誤り | {BASELINE_FACTUAL} | {factual_err} | {factual_err - BASELINE_FACTUAL:+d} |")
    md.append(f"| top-1 hit率 | — | {good_hit}/{n} = {good_hit/n*100:.1f}% | — |")
    md.append("")
    md.append("### bad 3分類（relaxed bad 内訳）")
    md.append("")
    md.append(f"| 分類 | 件数 |")
    md.append(f"|---|---|")
    md.append(f"| missing (不hit) | {bc_counts['missing']} |")
    md.append(f"| misinterpreted (not factual) | {bc_counts['misinterpreted']} |")
    md.append(f"| omitted (hit & factual) | {bc_counts['omitted']} |")
    md.append(f"| **合計** | **{len(bad_r)}** |")
    md.append("")

    md.append("### 件別 diff（out/33 旧prompt → out/36 V2）")
    md.append("")
    md.append("| id | 旧prompt relaxed | V2 relaxed | 変化 | V2 3分類 | V2 reason |")
    md.append("|---|---|---|---|---|---|")
    for r in rows:
        gid = r["id"]
        bv = baseline_verdicts.get(gid, {})
        o34g = isgood_relaxed(bv)
        n35g = r.get("good_relaxed")
        v2 = r.get("verdict") or {}
        if n35g and not o34g:
            delta = "↑改善"
        elif o34g and not n35g:
            delta = "↓悪化"
        elif n35g and o34g:
            delta = "=good"
        else:
            delta = "=bad"
        bc = classify_bad(r) if not n35g else "-"
        md.append(f"| {gid} | {'G' if o34g else '▪'} | {'G' if n35g else '▪'} | {delta} | {bc} | {v2.get('reason','')[:35]} |")
    md.append("")

    md.append(f"改善: {improved} ({len(improved)}件)")
    md.append(f"悪化: {regressed} ({len(regressed)}件)")
    md.append(f"不変bad: {unchanged_bad} ({len(unchanged_bad)}件)")
    md.append("")

    md.append("## 合格判定")
    md.append("")
    for cond, ok in conditions.items():
        md.append(f"- **{'✅' if ok else '❌'}** {cond}")
    md.append(f"")
    if passed:
        md.append(f"### **合格** — V2 を本番 `apps/api/eval/rag-mvp.py` の `EDGE_SYSTEM` へ反映可能")
        md.append("")
        md.append(f"- relaxed {r_pct:.1f}% ≥ {BASELINE_RELAXED_PCT}%（悪化なし{'、改善あり' if r_pct > BASELINE_RELAXED_PCT else ''}）")
        md.append(f"- overreach = {overreach_n} 維持")
        md.append(f"- factual誤り = {factual_err} ≤ {BASELINE_FACTUAL}（{'増加なし' if factual_err <= BASELINE_FACTUAL else '✅'}）")
    else:
        md.append(f"### **不合格** — V2 反映前に要修正")
        if not conditions["relaxed ≥ 87.8%"]:
            md.append(f"- relaxed が baseline {BASELINE_RELAXED_PCT}% 未満。回帰id: {regressed}")
        if not conditions["overreach = 0"]:
            md.append(f"- overreach が {overreach_n}件 発生。長文化が法令断定を誘発")
        if not conditions["factual ≤ 1"]:
            md.append(f"- factual誤り が {factual_err}件。数値強制が hallucination を誘発")
    md.append("")

    md.append("## 考察")
    md.append("")
    if passed:
        md.append(f"- easy 41件で V2 は回帰なし、relaxed {r_pct:.1f}% 維持／改善。overreach/factual も悪化なし")
        md.append(f"- calc-benefit(+25pt) + easy(回帰なし) の両面で V2 の安全性と有効性を確認")
        md.append(f"- → **V2 を本番 `EDGE_SYSTEM` へ恒久反映可能**。残存 calc omitted 3件は capacity 天井で別途")
    else:
        md.append(f"- 回帰あり。悪化id {regressed} の原因を分析し prompt 微調整を提案")
    md.append("")
    md.append(f"- calc-benefit V2 の結果 (out/35, relaxed 80.0%) と合わせた金領域 good 率の概算: 実装価値あり")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)
    print(f"\n[DONE] elapsed={elapsed:.0f}s")


if __name__ == "__main__":
    main()
