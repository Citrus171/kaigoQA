#!/usr/bin/env python3
"""out/38: gold tier 再精査。005/014 の単位数・LIFE関連refを supplement に降格し、
残存 omitted 3件が tier 変更で溶けるか検証。同一回答・同一judge・tierのみ変更。
"""
import json, os, time, re as _re, sys
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

ORK          = os.environ["OPENROUTER_API_KEY"]
OR_URL       = "https://openrouter.ai/api/v1/chat/completions"
JUDGE_MODEL  = os.environ.get("JUDGE_MODEL", "openai/gpt-4o")

GOLD_PATH    = os.path.join(DATA, "routing-gold-a.jsonl")
MODELCOMP_IN = os.path.join(DATA, "rag-mvp-cloud-calc-modelcomp.jsonl")
OUT_JSONL    = os.path.join(DATA, "rag-mvp-cloud-calc-modelcomp-tierrefined.jsonl")
RESULT_MD    = os.path.join(OUT, "38-tier-refinement.md")

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

# 再精査: 質問スコープ外の fact を supplement に降格
# 基準: 「質問が直接尋ねているか」
_manual_supp = {
    "gold-calc-005": [4, 5],   # [4]令和6年度改定(改定文脈), [5]単位数(質問はデータ提出要件)
    "gold-calc-014": [3, 5],   # [3]単位数+LIFE要件(質問は人員要件), [5]令和6年度改定(改定文脈)
}


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
    print(f"=== out/38: gold tier 再精査 (refined tiers for 005/014) ===")
    print(f"judge: {JUDGE_MODEL}")
    print(f"manual_supp: {_manual_supp}")

    gold_dict = {json.loads(l)["id"]: json.loads(l) for l in open(GOLD_PATH) if l.strip()}
    entries = [json.loads(l) for l in open(MODELCOMP_IN) if l.strip()]
    print(f"entries: {len(entries)} (20q × 3 models)")

    done = set()
    if os.path.exists(OUT_JSONL):
        for line in open(OUT_JSONL):
            if line.strip():
                o = json.loads(line)
                done.add((o["id"], o["model"]))

    rejudged_ids = set()
    with open(OUT_JSONL, "a") as fout:
        for i, e in enumerate(entries):
            gid = e["id"]
            model = e["model"]
            key = (gid, model)

            if key in done:
                continue

            g = gold_dict.get(gid, {})
            refs = g.get("referencePoints") or []
            tiers = [classify_tier(gid, idx, pt) for idx, pt in enumerate(refs)]
            n_main = sum(1 for t in tiers if t == "main")
            n_supp = sum(1 for t in tiers if t == "supplement")

            # Report tier changes for affected questions
            is_affected = gid in _manual_supp
            if is_affected and gid not in rejudged_ids:
                rejudged_ids.add(gid)
                print(f"\n  [{gid}] tier refined: main={n_main}, supp={n_supp}")
                for idx, (pt, t) in enumerate(zip(refs, tiers)):
                    marker = "← 降格" if gid in _manual_supp and idx in _manual_supp[gid] else ""
                    print(f"    [{idx}] {'M' if t=='main' else 'S'} {pt[:70]}... {marker}")

            ans = e.get("answer", "")
            if ans:
                try:
                    new_v = judge2axis(g["query"], ans, refs, tiers)
                except Exception as ex:
                    new_v = {"factual": False, "overreach": False,
                             "sufficient_relaxed": False, "sufficient_strict": False,
                             "category_relaxed": "error", "category_strict": "error",
                             "reason": str(ex)[:30]}
            else:
                new_v = {"factual": False, "overreach": False,
                         "sufficient_relaxed": False, "sufficient_strict": False,
                         "category_relaxed": "no_answer", "category_strict": "no_answer",
                         "reason": "生成失敗"}

            new_r = isgood_relaxed(new_v)
            new_s = isgood_strict(new_v)
            old_r = e.get("good_relaxed")
            old_v = e.get("verdict") or {}

            # Status change indicator
            if old_r and new_r:
                status = "=good"
            elif not old_r and new_r:
                status = "↑RESOLVED"
            elif old_r and not new_r:
                status = "↓REGRESS"
            else:
                status = "=bad"

            rec = {
                "id": gid, "model": model, "query": e["query"],
                "category": e.get("category"), "top1_src_id": e.get("top1_src_id"),
                "gid_in_top1": e.get("gid_in_top1"),
                "answer": ans,
                "verdict_old": old_v,
                "verdict_new": new_v,
                "good_relaxed_old": old_r,
                "good_relaxed_new": new_r,
                "good_strict_new": new_s,
                "tier_refined": is_affected,
                "reason_old": old_v.get("reason", ""),
                "reason_new": new_v.get("reason", ""),
                "status": status,
            }

            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fout.flush()

            if is_affected:
                print(f"  {gid}/{model}: old={'G' if old_r else '.'} → new={'G' if new_r else '.'} "
                      f"({old_v.get('reason','')[:30]} → {new_v.get('reason','')[:30]}) {status}", flush=True)
            else:
                if i % 20 == 0:
                    print(f"  [{i+1}/{len(entries)}] processing...", flush=True)
            time.sleep(0.2)

    # Aggregate results
    rows = [json.loads(l) for l in open(OUT_JSONL) if l.strip()]
    print(f"\n=== 集計 ({len(rows)} total) ===\n")

    by_model = {}
    for r in rows:
        by_model.setdefault(r["model"], []).append(r)

    models = ["deepseek-flash", "gpt-4o", "claude-sonnet"]
    print(f"{'model':<16} {'old relaxed':>14} {'new relaxed':>14} {'improved':>10}")
    for ml in models:
        mrows = by_model.get(ml, [])
        n = len(mrows)
        old_g = sum(1 for r in mrows if r.get("good_relaxed_old"))
        new_g = sum(1 for r in mrows if r.get("good_relaxed_new"))
        resolved = sum(1 for r in mrows if r.get("status") == "↑RESOLVED")
        print(f"{ml:<16} {old_g}/{n} = {old_g/n*100:.0f}% {new_g}/{n} = {new_g/n*100:.0f}% resolved={resolved}")

    # Focus: omitted 3 cases
    print(f"\n=== 残存 omitted 3件 tier再精査後 ===")
    print(f"{'id':<16} {'model':<16} {'old':>5} {'new':>5} {'status':>12} {'reason_old':>30} → {'reason_new':>30}")
    for r in rows:
        if r["id"] in ["gold-calc-004", "gold-calc-005", "gold-calc-014"]:
            print(f"{r['id']:<16} {r['model']:<16} "
                  f"{'G' if r['good_relaxed_old'] else '.'} "
                  f"{'G' if r['good_relaxed_new'] else '.'} "
                  f"{r['status']:>12} "
                  f"{r['reason_old'][:30]:>30} → {r['reason_new'][:30]}")

    # Write report
    elapsed = time.time() - t0
    md = []
    md.append("# 38: gold tier 再精査 (005/014 単位数降格 → omitted 溶解検証)")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 背景")
    md.append("")
    md.append("- out/37: calc-benefit 20件×3モデル比較。gold-calc-005 は全3モデルが omit → gold 要求水準の疑い")
    md.append("- 本レポート: 005/014 の単位数・LIFE関連refを supplement に降格し tier 変更だけで omitted が溶けるか検証")
    md.append("")
    md.append("## tier 再精査の基準")
    md.append("")
    md.append("「質問が直接尋ねているか」:")
    md.append("- gold-calc-005 query: 「**データ提出**には何が必要か」→ 単位数は質問スコープ外")
    md.append("- gold-calc-014 query: 「**歯科衛生士がいないとだめか**」→ 単位数・LIFE改定文脈は質問スコープ外")
    md.append("")
    md.append("## tier 変更内容")
    md.append("")
    md.append("| id | 降格ref (main→supp) | 理由 |")
    md.append("|---|---|---|")
    md.append("| gold-calc-005 | [4]令和6年度改定文脈, [5]単位数40-60単位/月 | 質問はデータ提出要件。単位数はスコープ外 |")
    md.append("| gold-calc-014 | [3]単位数150/160単位+LIFE要件, [5]令和6年度改定 | 質問は人員要件。単位数・改定文脈はスコープ外 |")
    md.append("")
    md.append("## 構成")
    md.append("")
    md.append(f"- 回答: out/37 のモデル別生成結果を再利用（再生成なし）")
    md.append(f"- judge: {JUDGE_MODEL} (OpenRouter, temp=0, 2軸, tierのみ変更)")
    md.append(f"- 対象: 20件 × 3モデル = 60 entries")
    md.append("")
    md.append("## 結果")
    md.append("")
    md.append("### モデル別 relaxed good 推移")
    md.append("")
    md.append("| モデル | out/37 (old tier) | out/38 (refined tier) | resolved |")
    md.append("|---|---|---|---|")
    for ml in models:
        mrows = by_model.get(ml, [])
        n = len(mrows)
        old_g = sum(1 for r in mrows if r.get("good_relaxed_old"))
        new_g = sum(1 for r in mrows if r.get("good_relaxed_new"))
        resolved = sum(1 for r in mrows if r.get("status") == "↑RESOLVED")
        md.append(f"| {ml} | {old_g}/{n} ({old_g/n*100:.0f}%) | {new_g}/{n} ({new_g/n*100:.0f}%) | {resolved} |")
    md.append("")

    md.append("### 残存 omitted 3件 × 3モデル 詳細")
    md.append("")
    md.append("| id | model | old relaxed | new relaxed | 変化 | old reason | new reason |")
    md.append("|---|---|---|---|---|---|---|")
    for r in rows:
        if r["id"] in ["gold-calc-004", "gold-calc-005", "gold-calc-014"]:
            md.append(f"| {r['id']} | {r['model']} | "
                      f"{'G' if r['good_relaxed_old'] else '▪'} | "
                      f"{'G' if r['good_relaxed_new'] else '▪'} | "
                      f"{r['status']} | "
                      f"{r['reason_old'][:25]} | {r['reason_new'][:25]} |")
    md.append("")

    # Count resolved by question
    md.append("### 質問別 resolved 集計")
    md.append("")
    for gid in ["gold-calc-004", "gold-calc-005", "gold-calc-014"]:
        qrows = [r for r in rows if r["id"] == gid]
        old_g = sum(1 for r in qrows if r.get("good_relaxed_old"))
        new_g = sum(1 for r in qrows if r.get("good_relaxed_new"))
        resolved = sum(1 for r in qrows if r.get("status") == "↑RESOLVED")
        is_affected = gid in _manual_supp
        md.append(f"- **{gid}**{' ← tier変更対象' if is_affected else ' (tier変更なし・参照)'}: "
                  f"old={old_g}/3 → new={new_g}/3 (resolved={resolved})")
    md.append("")

    md.append("## 考察")
    md.append("")
    # Determine if tier change resolved the omitted cases
    resolved_total = sum(1 for r in rows if r.get("status") == "↑RESOLVED" and r["id"] in ["gold-calc-005", "gold-calc-014"])
    if resolved_total >= 2:
        md.append(f"- **tier 再精査は有効**: {resolved_total}件の omitted が溶解。単位数/LIFEの降格で gold が relaxed 軸の原則（核心の欠落のみ bad）に整合")
        md.append(f"- → gold tier 再精査を恒久採用し、gold データの ★ 付与を修正すべき")
    elif resolved_total >= 1:
        md.append(f"- **tier 再精査は部分有効**: {resolved_total}件溶解。残存は tier 以外の要因（回答の質自体が不十分）")
    else:
        md.append(f"- **tier 再精査では不十分**: 単位数を supplement に降格しても omitted が溶解しなかった。回答の質自体が要件を満たせていない")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)
    print(f"\n[DONE] elapsed={elapsed:.0f}s")


if __name__ == "__main__":
    main()
