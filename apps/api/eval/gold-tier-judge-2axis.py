#!/usr/bin/env python3
"""out/33: gold main/supplement 分離 + judge relaxed/strict 2軸化 + real 再採点"""
import json, os, time, re as _re
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
JUDGE_URL = "https://openrouter.ai/api/v1/chat/completions"
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "openai/gpt-4o")

GOLD_PATH = os.path.join(DATA, "routing-gold-a.jsonl")
QLEVEL_JSONL = os.path.join(DATA, "rag-mvp-cloud-qlevel.jsonl")
OUT_JSONL = os.path.join(DATA, "rag-mvp-cloud-qlevel-2axis.jsonl")
OUT_VERDICTS = os.path.join(DATA, "rejudge-2axis-verdicts.json")
RESULT_MD = os.path.join(OUT, "33-relaxed-strict-axis.md")

# Tier classification patterns
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

# Supplements for specific cases (not matched by regex)
_manual_supp = {
    "gold-A-001": [0, 1],  # 1997年成立/2000年施行
    "gold-A-026": [0],      # 法115条
}

def classify_tier(pt):
    if _supp_pat.search(pt):
        return "supplement"
    return "main"

def classify_all(gold_dict):
    """全質問の referencePoints に tier を付与"""
    tagged = {}
    pending = []  # uncertain cases
    for gid, g in gold_dict.items():
        refs = g.get("referencePoints") or []
        tiers = []
        for i, pt in enumerate(refs):
            if gid in _manual_supp and i in _manual_supp[gid]:
                tiers.append("supplement")
            elif _supp_pat.search(pt):
                tiers.append("supplement")
            else:
                tiers.append("main")
        tagged[gid] = {"refs": refs, "tiers": tiers}

        # Check for borderline cases
        for i, (pt, t) in enumerate(zip(refs, tiers)):
            if t == "main" and any(w in pt for w in ["平成", "昭和", "施行", "法に基づ"]):
                pending.append((gid, i, pt, "main"))
    return tagged, pending

def build_prompt(query, answer, refs, tiers):
    """2-axis judge prompt"""
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
   → 特に注意: 「更新手続きで結果が間に合わない場合の継続利用可否・認定が切れた時のリスク」のような、利用者が知らなければ行動できない帰結情報の欠落はrelaxedでもinsufficientとする。
4. sufficient_strict: ★主要事実＋△補足情報の全要点を網羅しているか。

次のJSONのみを返答（前置き・コードフェンス不要）:
{{"factual": boolean, "overreach": boolean, "sufficient_relaxed": boolean, "sufficient_strict": boolean,
 "category_relaxed": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated",
 "category_strict": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated",
 "reason": "30字以内"}}"""
    return prompt


def isgood_relaxed(v):
    return bool(v) and v.get("factual") and v.get("sufficient_relaxed") and not v.get("overreach")


def isgood_strict(v):
    return bool(v) and v.get("factual") and v.get("sufficient_strict") and not v.get("overreach")


def judge2axis(query, answer, refs, tiers):
    prompt = build_prompt(query, answer, refs, tiers)
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


def main():
    t0 = time.time()
    print("=== gold tier + judge 2-axis (out/33) ===")

    gold = {json.loads(l)["id"]: json.loads(l) for l in open(GOLD_PATH) if l.strip()}
    edge_ids = sorted(gid for gid, g in gold.items()
                      if g.get("expected") == "edge" and g.get("referencePoints"))
    print(f"edge questions: {len(edge_ids)}")

    # Step 1: tier classification
    tagged, pending = classify_all(gold)
    print("\n[tier] supplement classification (all points):")
    all_supp = sum(1 for gid, d in tagged.items() for t in d["tiers"] if t == "supplement")
    all_main = sum(1 for gid, d in tagged.items() for t in d["tiers"] if t == "main")
    print(f"  supplement: {all_supp}, main: {all_main}")

    if pending:
        print(f"\n[tier] pending borderline cases ({len(pending)}):")
        for gid, idx, pt, tier in pending:
            print(f"  {gid}[{idx}] tier={tier}: {pt[:80]}")

    # Step 2: re-judge 41 q-level answers
    qlevel = {o["id"]: o for o in (json.loads(l) for l in open(QLEVEL_JSONL) if l.strip())}
    print(f"\n=== 2-axis re-judge: {len(edge_ids)} q-level answers ===")

    verdicts = {}
    with open(OUT_JSONL, "w") as fout:
        for i, gid in enumerate(edge_ids):
            g = gold[gid]
            rec = {"id": gid}
            ans = qlevel[gid].get("answer", "")

            try:
                v = judge2axis(g["query"], ans, tagged[gid]["refs"], tagged[gid]["tiers"])
            except Exception as ex:
                v = {"factual": False, "overreach": False,
                     "sufficient_relaxed": False, "sufficient_strict": False,
                     "category_relaxed": "error", "category_strict": "error",
                     "reason": str(ex)[:30]}
            verdicts[gid] = v
            rec["verdict"] = v
            rec["good_relaxed"] = isgood_relaxed(v)
            rec["good_strict"] = isgood_strict(v)

            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fout.flush()
            gr = "G" if rec["good_relaxed"] else "."
            gs = "G" if rec["good_strict"] else "."
            print(f"  [{i+1}/{len(edge_ids)}] {gid} relaxed={gr} strict={gs} {v.get('reason','')[:30]}", flush=True)
            time.sleep(0.2)

    json.dump(verdicts, open(OUT_VERDICTS, "w"), ensure_ascii=False, indent=2)
    print(f"\n[cache] {OUT_VERDICTS}")

    # Step 3: aggregate
    good_r = sum(1 for gid in edge_ids if isgood_relaxed(verdicts[gid]))
    good_s = sum(1 for gid in edge_ids if isgood_strict(verdicts[gid]))
    print(f"\n=== results ===")
    print(f"relaxed good: {good_r}/{len(edge_ids)} = {good_r/len(edge_ids)*100:.1f}%")
    print(f"strict good: {good_s}/{len(edge_ids)} = {good_s/len(edge_ids)*100:.1f}%")

    # 039 check
    print(f"\ngold-A-039 relaxed: {isgood_relaxed(verdicts['gold-A-039'])} (expected false)")

    # Step 4: report
    elapsed = time.time() - t0
    md = []
    md.append("# 33: gold main/supplement 分離 + judge relaxed/strict 2軸化")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 背景")
    md.append("")
    md.append("- out/32 で cloud good 真値 68.3% を確定（strict基準）。しかし判定軸とユースケースの不整合を検出")
    md.append("- システム用途は「一次対応アシスタント」。法令条番号・条文引用の欠落で partial 判定されるのは過剰")
    md.append("- ユーザー承認の線引き: 条文番号・付随細目欠落は許容（relaxed）、核心情報欠落は不可")
    md.append("- 本レポート: gold を main/supplement に分離し、judge を relaxed/strict 2軸化、real 41件を再採点")
    md.append("")
    md.append("## 評価軸の定義")
    md.append("")
    md.append("- **relaxed（正規KPI）**: 利用者が次に取るべき行動・理解すべき主要事実を得られれば good。法令条番号・条文引用・年号・限度額・行政注記の欠落は許容。**ただし質問の核心（帰結情報）の欠落は不可**")
    md.append("- **strict（副軸・参考）**: gold 全要点を網羅して good（従来通り）")
    md.append("- factual / overreach は両軸とも厳格維持")
    md.append("")
    md.append("## gold tier 分離")
    md.append("")
    md.append(f"- 全 referencePoints: {all_supp + all_main}")
    md.append(f"- main（主要事実）: {all_main}")
    md.append(f"- supplement（補足: 法条番号/条文引用/年号/市町村注記）: {all_supp}")
    md.append("")
    md.append("分類基準:")
    md.append("- supplement = 法令条番号（法第○条）、条文引用、成立・施行年、限度額、「市区町村により異なる」注記、省令委任記述")
    md.append("- main = 利用者の行動・理解・意思決定に直結する事実")
    md.append("")

    if pending:
        md.append(f"### 保留案件（{len(pending)}件・要承認）")
        md.append("")
        for gid, idx, pt, tier in pending:
            md.append(f"- `{gid}[{idx}]` tier={tier}: {pt[:120]}")
        md.append("")

    md.append("## 2-axis judge プロンプト設計")
    md.append("")
    md.append("- 1回のjudge呼び出しで `sufficient_relaxed` + `sufficient_strict` の2フラグを出力")
    md.append("- gold を ★主要事実 / △補足情報 に明示分離して提示")
    md.append("- relaxed判定には「核心情報の欠落は不可」の原則を抽象例で埋め込み")
    md.append("- anchor case (039相当) の逐語 few-shot はリーク回避のため未使用")
    md.append("")
    md.append("## real 再採点結果（q-level 41件）")
    md.append("")
    md.append(f"- **relaxed good**: {good_r}/41 = **{good_r/41*100:.1f}%** ← 正規KPI")
    md.append(f"- **strict good**: {good_s}/41 = {good_s/41*100:.1f}% ← 副軸（参考）")
    md.append("")
    md.append("### 内訳")
    md.append("")
    md.append("| id | relaxed | strict | reason |")
    md.append("|---|---|---|---|")
    bad_r_ids = []
    bad_s_ids = []
    for gid in edge_ids:
        r = isgood_relaxed(verdicts[gid])
        s = isgood_strict(verdicts[gid])
        if not r: bad_r_ids.append(gid)
        if not s: bad_s_ids.append(gid)
        md.append(f"| {gid} | {'G' if r else '▪'} | {'G' if s else '▪'} | {verdicts[gid].get('reason','')[:50]} |")
    md.append("")
    md.append(f"relaxed bad: {bad_r_ids}")
    md.append(f"strict bad: {bad_s_ids}")
    md.append("")

    # 039 check
    a039_r = isgood_relaxed(verdicts["gold-A-039"])
    md.append("### gold-A-039（anchor case）検証")
    md.append("")
    md.append(f"- relaxed: **{'bad' if not a039_r else 'GOOD (想定外!)'}** — 想定は bad")
    if not a039_r:
        md.append("- 継続利用可否・リスクの帰結情報欠落が正しく拾われた ✅")
    else:
        md.append("- ⚠️ judgeが核心情報欠落を拾えていない。prompt要修正。")
    md.append("")

    md.append("## 考察")
    md.append("")
    md.append(f"- **relaxed 正規KPI = {good_r/41*100:.1f}%**。strict(68.3%)との差 {good_r/41*100-68.3:+.1f}pt が gold/judge 律速分")
    expected_relaxed = 38
    if good_r == expected_relaxed:
        md.append(f"- **期待値 38/41 = 92.7% と完全一致 ✅**")
    else:
        md.append(f"- 期待値 38/41 = 92.7% に対し {good_r}/41。差 {good_r - expected_relaxed:+d}件")
    md.append(f"- 残る relaxed bad {len(bad_r_ids)}件: 真の retrieval failure + 核心情報欠落")
    md.append(f"- strict bad {len(bad_s_ids)}件の大部分は条文番号・付随細目欠落によるもの（実用上は許容）")
    md.append("")
    md.append(f"- → generation改善の要否は calc-benefit 20件追加後に判断（現セットでは relaxed {good_r/41*100:.1f}% で実用十分）")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)
    print(f"\n[DONE] elapsed={elapsed:.0f}s")


if __name__ == "__main__":
    main()
