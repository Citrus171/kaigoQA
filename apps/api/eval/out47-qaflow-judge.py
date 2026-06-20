#!/usr/bin/env python3
"""out/47: 本番qaflow答案を out/44 と完全同一judge（GPT-4o・全referencePoints・temp0）で採点。

比較軸:
  - out/44 実RAG edge 90.2%（Gemma4 thinkOFF+V2, eval用生成経路）
  - 本番 /ai/qa flow の生成経路が同じ品質の答案を生むか（配線忠実性検証）
  - relaxed軸（★核心要点のみ）／strict軸（全要点）の2軸判定
  - oracle 2x2 故障分離（retrieval vs reasoning failure）
  - oracle非対称の停止条件を明記
"""

import json, os, time, re as _re, sys, math
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

ORK = os.environ["OPENROUTER_API_KEY"]
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "openai/gpt-4o")
JUDGE_URL = "https://openrouter.ai/api/v1/chat/completions"

QAFLOW_JSONL = os.path.join(DATA, "rag-mvp-edge-qaflow.jsonl")
GOLD_PATH    = os.path.join(DATA, "routing-gold-a.jsonl")
ORACLE_JSONL = os.path.join(DATA, "rag-mvp-edge-oracle-out44.jsonl")
OUT_SIMPLE   = os.path.join(DATA, "rag-mvp-qaflow-judge-out47.jsonl")
OUT_2AXIS    = os.path.join(DATA, "rag-mvp-qaflow-2axis-out47.jsonl")
RESULT_MD    = os.path.join(OUT, "47-qaflow-judge.md")

# ── tier classification (from out/33 gold-tier-judge-2axis.py) ──
_supp_pat = _re.compile(
    r'(介護保険法第|法第\d+条|法第\d+条の\d+|老人福祉法第|'
    r'\d+年\d+月に施行|\d+年に施行|介護保険法に基づき[^、]*省令|'
    r'各事業者の指定基準は介護保険法|省令で定められ|'
    r'市区町村により異なる|事前確認を推奨|'
    r'^\d+年（平成|平成\d+年|'
    r'同法第|に規定$|に根拠規定がある|'
    r'に基づく$|に基づく居宅介護支援|'
    r'[、。]介護保険法第|'
    r'^★介護保険法第)')

_manual_supp = {
    "gold-A-001": [0, 1],
    "gold-A-026": [0],
    "gold-calc-005": [4, 5],
    "gold-calc-014": [3, 5],
}

def classify_tiers(gid, refs):
    tiers = []
    for i, pt in enumerate(refs):
        if gid in _manual_supp and i in _manual_supp[gid]:
            tiers.append("supplement")
        elif _supp_pat.search(pt):
            tiers.append("supplement")
        else:
            tiers.append("main")
    return tiers

# ── load ──
def load_jsonl(path):
    if not os.path.exists(path): return []
    return [json.loads(l) for l in open(path) if l.strip()]

# ── judge: out/44 identical (simple factual/sufficient/overreach) ──
def judge_simple(query, answer, gold_refs):
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

# ── judge: 2-axis (relaxed/strict) ──
def judge_2axis(query, answer, refs, tiers):
    main_pts = [f"★ {pt}" for pt, t in zip(refs, tiers) if t == "main"]
    supp_pts = [f"△ {pt}" for pt, t in zip(refs, tiers) if t == "supplement"]

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
   → 特に注意: 「更新手続きで結果が間に合わない場合の継続利用可否・認定が切れた時のリスク」のような、利用者が知らなければ行動できない帰結情報の欠落はrelaxedでもinsufficientとする。
4. sufficient_strict: ★主要事実＋△補足情報の全要点を網羅しているか。

次のJSONのみを返答（前置き・コードフェンス不要）:
{{"factual": boolean, "overreach": boolean, "sufficient_relaxed": boolean, "sufficient_strict": boolean,
 "category_relaxed": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated",
 "category_strict": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated",
 "reason": "30字以内"}}"""
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

def isgood(v):
    return bool(v) and v.get("factual") and v.get("sufficient") and not v.get("overreach")

def isgood_relaxed(v):
    return bool(v) and v.get("factual") and v.get("sufficient_relaxed") and not v.get("overreach")

def isgood_strict(v):
    return bool(v) and v.get("factual") and v.get("sufficient_strict") and not v.get("overreach")

def pct(n, d):
    return f"{n/d*100:.1f}%" if d > 0 else "—"

# ── 2x2 ──
def two_by_two(oracle_dict, real_dict, label):
    ids = sorted(set(oracle_dict) & set(real_dict))
    both_ok = retrieval_failure = reasoning_failure = odd = 0
    oracle_good = 0
    retrieval_fail_items = []
    reasoning_fail_items = []
    odd_items = []
    both_ok_items = []

    for gid in ids:
        og = bool(oracle_dict[gid].get("good"))
        rg = bool(real_dict[gid].get("good"))
        if og:
            oracle_good += 1
            if rg:
                both_ok += 1
                both_ok_items.append(gid)
            else:
                retrieval_failure += 1
                retrieval_fail_items.append(gid)
        else:
            if rg:
                odd += 1
                odd_items.append(gid)
            else:
                reasoning_failure += 1
                reasoning_fail_items.append(gid)

    n = len(ids)
    real_good = both_ok + odd
    return {
        "label": label, "n": n,
        "oracle_good": oracle_good, "real_good": real_good,
        "both_ok": both_ok, "retrieval_failure": retrieval_failure,
        "reasoning_failure": reasoning_failure, "odd": odd,
        "retrieval_fail_items": retrieval_fail_items,
        "reasoning_fail_items": reasoning_fail_items,
        "odd_items": odd_items,
        "both_ok_items": both_ok_items,
    }

# ── latency stats ──
def latency_stats(rows):
    vals = sorted([r.get("latency", 0) for r in rows])
    if not vals: return {}
    n = len(vals)
    return {"avg": sum(vals)/n, "p50": vals[n//2], "min": vals[0], "max": vals[-1],
            "p95": vals[int(n*0.95)] if int(n*0.95) < n else vals[-1]}

# ── main ──
def main():
    t0 = time.time()
    print("=== out/47: 本番qaflow答案 judge（out/44完全同一judge + 2軸relaxed/strict）===")

    # load
    qaflow = {o["id"]: o for o in load_jsonl(QAFLOW_JSONL)}
    gold = {g["id"]: g for g in load_jsonl(GOLD_PATH)}
    oracle_rows = [o for o in load_jsonl(ORACLE_JSONL)]
    oracle_dict = {o["id"]: o for o in oracle_rows}

    ids = sorted(set(qaflow) & {g["id"] for g in gold.values()
                                  if g.get("referencePoints") and g.get("expected") == "edge"})
    print(f"対象: {len(ids)}件 (edge想定 / answerあり / referencePointsあり)")

    # tier classification for 2-axis
    tier_map = {}
    for gid in ids:
        refs = gold[gid].get("referencePoints", [])
        tier_map[gid] = classify_tiers(gid, refs)

    main_count = sum(1 for gid in ids for t in tier_map[gid] if t == "main")
    supp_count = sum(1 for gid in ids for t in tier_map[gid] if t == "supplement")
    print(f"tier分離: main={main_count} supp={supp_count}")

    STATIC = os.environ.get("OUT47_STATIC", "0") == "1"

    # ── Step 1: simple judge (out/44 identical) ──
    if STATIC:
        print("\n[OUT47_STATIC=1] 既存jsonlから読み込み（judgeスキップ）")
        simple_rows = load_jsonl(OUT_SIMPLE)
    else:
        print("\n=== Step 1: 簡易judge（out/44完全同一プロンプト） ===")
        simple_rows = []
        with open(OUT_SIMPLE, "w") as fout:
            for i, gid in enumerate(ids):
                q = qaflow[gid]
                g = gold[gid]
                refs = g.get("referencePoints", [])
                ans = q.get("answer", "")
                rec = {"id": gid, "query": q["query"], "answer": ans}
                try:
                    v = judge_simple(q["query"], ans, refs)
                except Exception as ex:
                    v = {"factual": False, "overreach": False, "sufficient": False,
                         "category": "refusal", "reason": str(ex)[:30]}
                rec["verdict"] = v
                rec["good"] = isgood(v)
                simple_rows.append(rec)
                fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
                fout.flush()
                gd = "G" if rec["good"] else "."
                print(f"  [{i+1}/{len(ids)}] {gid} simple={gd} {v.get('reason','')[:30]}", flush=True)
                time.sleep(0.3)
        print(f"保存: {OUT_SIMPLE}")

    simple_good = sum(1 for r in simple_rows if r.get("good"))
    simple_n = len(simple_rows)
    print(f"\nsimple good (out/44同一judge): {simple_good}/{simple_n} = {pct(simple_good, simple_n)}")

    # ── Step 2: 2-axis judge ──
    if STATIC:
        print("\n[OUT47_STATIC=1] 既存2axis jsonlから読み込み")
        axis_rows = load_jsonl(OUT_2AXIS)
    else:
        print("\n=== Step 2: 2軸judge（relaxed / strict）===")
        axis_rows = []
        with open(OUT_2AXIS, "w") as fout:
            for i, gid in enumerate(ids):
                q = qaflow[gid]
                g = gold[gid]
                refs = g.get("referencePoints", [])
                tiers = tier_map[gid]
                ans = q.get("answer", "")
                rec = {"id": gid, "query": q["query"], "answer": ans}
                try:
                    v = judge_2axis(q["query"], ans, refs, tiers)
                except Exception as ex:
                    v = {"factual": False, "overreach": False,
                         "sufficient_relaxed": False, "sufficient_strict": False,
                         "category_relaxed": "error", "category_strict": "error",
                         "reason": str(ex)[:30]}
                rec["verdict"] = v
                rec["good_relaxed"] = isgood_relaxed(v)
                rec["good_strict"] = isgood_strict(v)
                axis_rows.append(rec)
                fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
                fout.flush()
                gr = "G" if rec["good_relaxed"] else "."
                gs = "G" if rec["good_strict"] else "."
                print(f"  [{i+1}/{len(ids)}] {gid} relaxed={gr} strict={gs} {v.get('reason','')[:30]}", flush=True)
                time.sleep(0.3)
        print(f"保存: {OUT_2AXIS}")

    good_relaxed = sum(1 for r in axis_rows if r.get("good_relaxed"))
    good_strict = sum(1 for r in axis_rows if r.get("good_strict"))
    axis_n = len(axis_rows)
    print(f"\nrelaxed good: {good_relaxed}/{axis_n} = {pct(good_relaxed, axis_n)}")
    print(f"strict good: {good_strict}/{axis_n} = {pct(good_strict, axis_n)}")

    # ── Step 3: 2x2 with oracle ──
    print("\n=== Step 3: 2x2 故障分離（oracle vs qaflow）===")
    simple_dict = {r["id"]: r for r in simple_rows}
    twobytwo = two_by_two(oracle_dict, simple_dict, "qaflow vs oracle")

    # ── Step 4: verify out44 consistency ──
    print("\n=== Step 4: out/44 回答を同一judgeで再検算（answer同一性確認）===")
    out44_rows = load_jsonl(os.path.join(DATA, "rag-mvp-edge-out44.jsonl"))
    out44_dict = {r["id"]: r for r in out44_rows}

    # cross-check: items where qaflow and out44 answers differ
    diff_items = []
    match_good = 0
    diff_good_qaflow_worse = 0
    diff_good_qaflow_better = 0
    for gid in ids:
        qa_ans = qaflow[gid].get("answer", "")
        o44_ans = out44_dict.get(gid, {}).get("answer", "")
        qa_good = simple_dict.get(gid, {}).get("good", False)
        o44_good = out44_dict.get(gid, {}).get("good", False)
        if qa_ans.strip() == o44_ans.strip():
            match_good += 1
        else:
            diff_items.append(gid)
            if not qa_good and o44_good:
                diff_good_qaflow_worse += 1
            elif qa_good and not o44_good:
                diff_good_qaflow_better += 1

    print(f"同一回答: {match_good}/{len(ids)}")
    print(f"回答差あり: {len(diff_items)}件（qaflow→bad & out44→good: {diff_good_qaflow_worse}, qaflow→good & out44→bad: {diff_good_qaflow_better}）")

    # ── Step 5: mismatch analysis ──
    print("\n=== Step 5: 不一致件の分析 ===")
    # Items where qaflow != out44 good verdict
    mismatch_bad = [gid for gid in ids
                    if simple_dict.get(gid, {}).get("good") != out44_dict.get(gid, {}).get("good")]
    mismatch_good_qaflow = [gid for gid in mismatch_bad if simple_dict.get(gid, {}).get("good")]
    mismatch_good_out44 = [gid for gid in mismatch_bad if out44_dict.get(gid, {}).get("good")]
    print(f"good不一致件: {len(mismatch_bad)}件")
    print(f"  qaflow→good / out44→bad: {len(mismatch_good_qaflow)}件")
    print(f"  qaflow→bad / out44→good: {len(mismatch_good_out44)}件")

    # ── oracle asymmetry analysis ──
    print("\n=== Step 6: oracle非対称 ===")
    oracle_only_bad = [gid for gid in ids
                       if oracle_dict.get(gid, {}).get("good") == False
                       and simple_dict.get(gid, {}).get("good") == True]
    oracle_only_good = [gid for gid in ids
                        if oracle_dict.get(gid, {}).get("good") == True
                        and simple_dict.get(gid, {}).get("good") == False]
    print(f"oracle=bad / qaflow=good (不可解な逆転): {len(oracle_only_bad)}件")
    if oracle_only_bad:
        for gid in oracle_only_bad:
            v = oracle_dict[gid].get("verdict", {})
            print(f"  {gid}: oracle bad原因={v.get('reason','?')}")
    print(f"oracle=good / qaflow=bad (retrieval failure): {len(oracle_only_good)}件")

    # ── Report ──
    elapsed = time.time() - t0
    simple_pct = simple_good / max(simple_n, 1) * 100
    out44_pct = 90.2  # from out/44

    md = []
    md.append("# 47: 本番qaflow答案 judge（out/44完全同一judge + 2軸）")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 目的")
    md.append("")
    md.append("- 本番 `/ai/qa` 経由の答案を out/44 と完全同一のjudge（GPT-4o・全referencePoints統一・temp0）で採点")
    md.append("- out/44 eval経路 90.2% との対比により、生成経路（eval配線 vs 本番配線）の忠実性を検証")
    md.append("- relaxed/strict 2軸判定で実用KPIと専門的十分さを分離")
    md.append("- oracle非対称の停止条件を明記")
    md.append("")
    md.append("## 構成")
    md.append(f"- judge model: {JUDGE_MODEL} (OpenRouter, temp=0)")
    md.append(f"- 入力: `rag-mvp-edge-qaflow.jsonl`（41件、本番qaflow生成答案）")
    md.append(f"- 参照: gold-a全referencePoints（edge想定41件）")
    md.append("- judge: out/44 と完全同一の簡易prompt + 2軸relaxed/strict prompt の2系統")
    md.append("")
    md.append("## 結果")
    md.append("")
    md.append("### simple judge（out/44 完全同一）")
    md.append("")
    md.append(f"- **本番qaflow good: {simple_good}/{simple_n} = {pct(simple_good, simple_n)}**")
    md.append(f"- out/44 実RAG edge good: 37/41 = 90.2%（基準）")
    md.append(f"- **差: {simple_pct - out44_pct:+.1f}pt**")
    md.append(f"- 生成経路の忠実性: {'✅ 維持（差≦許容）' if abs(simple_pct - out44_pct) <= 5 else '🔴 eval経路との乖離あり'}")
    md.append("")

    md.append("### 2軸 judge（relaxed / strict）")
    md.append("")
    md.append(f"- **relaxed good（★核心要点のみ）: {good_relaxed}/{axis_n} = {pct(good_relaxed, axis_n)}** ← 実用KPI")
    md.append(f"- strict good（全要点網羅）: {good_strict}/{axis_n} = {pct(good_strict, axis_n)} ← 参考")
    relaxed_pct = good_relaxed / max(axis_n, 1) * 100

    # latency
    ls = latency_stats(list(qaflow.values()))
    if ls:
        md.append("")
        md.append("### 応答時間（本番qaflow実測）")
        md.append("")
        md.append(f"- avg={ls['avg']:.0f}ms / p50={ls['p50']:.0f}ms / p95={ls.get('p95',0):.0f}ms / max={ls['max']}ms")

    md.append("")
    md.append("### 2×2: oracle vs qaflow")
    md.append("")
    md.append("| | qaflow good | qaflow bad |")
    md.append("|---|---|---|")
    md.append(f"| **Oracle good** | {twobytwo['both_ok']} (検索も推論もOK) | {twobytwo['retrieval_failure']} (retrieval failure) |")
    md.append(f"| **Oracle bad** | {twobytwo['odd']} (稀) | {twobytwo['reasoning_failure']} (reasoning/capacity failure) |")
    md.append("")
    md.append(f"- oracle good: {twobytwo['oracle_good']}/{twobytwo['n']} = {pct(twobytwo['oracle_good'], twobytwo['n'])}")
    md.append(f"- qaflow good: {twobytwo['real_good']}/{twobytwo['n']} = {pct(twobytwo['real_good'], twobytwo['n'])}")
    md.append(f"- retrieval loss: {pct(twobytwo['oracle_good'], twobytwo['n'])} → {pct(twobytwo['real_good'], twobytwo['n'])} (Δ={abs(twobytwo['oracle_good'] - twobytwo['real_good']) / twobytwo['n'] * 100:.1f}pts)")
    md.append(f"- retrieval failure: {twobytwo['retrieval_failure']}/{twobytwo['n']} ({pct(twobytwo['retrieval_failure'], twobytwo['n'])})")
    md.append(f"- reasoning failure: {twobytwo['reasoning_failure']}/{twobytwo['n']} ({pct(twobytwo['reasoning_failure'], twobytwo['n'])})")
    if twobytwo['odd'] > 0:
        md.append(f"- **不可解な逆転（oracle bad/qaflow good）: {twobytwo['odd']}件 → oracle judge失敗 または qaflowがoracle超えの生成を偶然成功したケース**")
    md.append("")

    md.append("### 不一致分析（out/44 vs qaflow のgood判定不一致）")
    md.append("")
    md.append(f"- 判定不一致: {len(mismatch_bad)}件")
    md.append(f"  - qaflow→good / out44→bad: {len(mismatch_good_qaflow)}件")
    md.append(f"  - qaflow→bad / out44→good: {len(mismatch_good_out44)}件")
    if diff_items:
        md.append(f"- 回答本文差異あり: {len(diff_items)}件（qaflow bad / out44 good: {diff_good_qaflow_worse}件）")
    md.append("")

    md.append("### 全件内訳")
    md.append("")
    md.append("| id | simple | relaxed | strict | simple reason | 2axis reason | answer同一 |")
    md.append("|---|---|---|---|---|---|---|")
    for gid in ids:
        sv = simple_dict.get(gid, {}).get("verdict", {})
        av = {r["id"]: r for r in axis_rows}.get(gid, {}).get("verdict", {})
        sg = "G" if simple_dict.get(gid, {}).get("good") else "."
        rg = "G" if {r["id"]: r for r in axis_rows}.get(gid, {}).get("good_relaxed") else "."
        stg = "G" if {r["id"]: r for r in axis_rows}.get(gid, {}).get("good_strict") else "."
        qa_ans = qaflow[gid].get("answer", "")
        o44_ans = out44_dict.get(gid, {}).get("answer", "")
        same = "Y" if qa_ans.strip() == o44_ans.strip() else "N"
        md.append(f"| {gid} | {sg} | {rg} | {stg} | {sv.get('reason','')[:25]} | {av.get('reason','')[:25]} | {same} |")
    md.append("")

    md.append("## oracle非対称の停止条件")
    md.append("")
    md.append("oracle good ≠ qaflow good の非対称が生じる場合、以下の停止条件で原因を特定しそれ以上追わない:")
    md.append("")
    md.append("| パターン | 意味 | 停止条件 |")
    md.append("|---|---|---|")
    md.append("| oracle=good / qaflow=bad | retrieval failure（検索品質問題） | oracle注入すれば正答できるので、**生成モデルの推論能力に問題なし**。検索側（embed/rerank/k）のチューニングに注力。 |")
    md.append("| oracle=bad / qaflow=good | 不可解な逆転 | **oracle judgeの採点ミス または oracle=goodの基準以下でqaflowが偶然良い回答を生成**。oracle verdictを再検証し、明らかな誤判定ならoracle回答を再生成。改善しなければそれ以上追わない（oracleの理論上限ではない実測上限として扱う）。 |")
    md.append("| oracle=bad / qaflow=bad | reasoning/capacity failure（生成モデルの能力限界） | oracle注入でも不正解なので、**検索の良し悪し以前にモデル能力の問題**。プロンプト改善・より強力なモデルへの変更を検討。qaflow側の改善では解決不可。 |")
    md.append("| oracle=good / qaflow=good | 理想状態 | 検索・推論とも問題なし。停止。 |")
    md.append("")
    md.append("### 今回の2x2に対する停止判断")
    md.append("")
    if twobytwo['retrieval_failure'] > 0:
        md.append(f"- **retrieval failure {twobytwo['retrieval_failure']}件**: 検索品質の改善余地あり。該当: `{twobytwo['retrieval_fail_items']}`")
    if twobytwo['reasoning_failure'] > 0:
        md.append(f"- **reasoning failure {twobytwo['reasoning_failure']}件**: モデル能力限界。プロンプト/モデル変更を検討。該当: `{twobytwo['reasoning_fail_items']}`")
    if twobytwo['odd'] > 0:
        md.append(f"- **不可解な逆転 {twobytwo['odd']}件**: oracle verdict検証要。該当: `{twobytwo['odd_items']}`")
    if twobytwo['retrieval_failure'] == 0 and twobytwo['reasoning_failure'] == 0 and twobytwo['odd'] == 0:
        md.append("- ✅ 全件 oracle=good / qaflow=good。追加調査不要。")
    md.append("")

    md.append("## 考察")
    md.append("")
    md.append(f"- **生成経路の忠実性**: out/44 eval経路 {out44_pct}% に対し本番qaflow {simple_pct:.1f}%。差 {simple_pct - out44_pct:+.1f}pt。")
    if abs(simple_pct - out44_pct) <= 2.5:
        md.append(f"- ✅ **eval経路と本番経路で生成品質は同等**。配線（/ai/qaエンドポイント→RAG→生成→回答）はeval配線（out44.py→retrieval→gen）と同等の答案を生んでいる。")
    elif simple_pct < out44_pct - 2.5:
        md.append(f"- 🔴 **本番経路がeval経路より {out44_pct - simple_pct:.1f}pt 低い**。配線の差異（プロンプト/モデル設定/RAGパラメータ）を調査要。")
    else:
        md.append(f"- ℹ️ 本番経路がeval経路より高いが、統計的有意差の範囲内（41件では±7.5%程度のサンプリング誤差あり）。")
    md.append("")
    md.append(f"- **実用KPI（relaxed）: {relaxed_pct:.1f}%**。一次対応アシスタントとしての実用性。")
    md.append(f"- strict → relaxed の改善幅: {relaxed_pct - good_strict / max(axis_n, 1) * 100:+.1f}pt（条文番号・付随細目の許容による）")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)
    print(f"\n[DONE] elapsed={elapsed:.0f}s")

if __name__ == "__main__":
    main()
