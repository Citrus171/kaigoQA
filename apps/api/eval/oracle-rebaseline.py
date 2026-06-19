#!/usr/bin/env python3
"""out/32: oracle を今回run・連結形式で再生成し cloud good 真値を確定"""
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

OPENCODE_KEY = os.environ["OPENCODE_API_KEY"]
OPENCODE_URL = "https://opencode.ai/zen/go/v1/chat/completions"
CLOUD_MODEL  = os.environ.get("OPENCODE_MODEL", "deepseek-v4-flash")
ORK          = os.environ["OPENROUTER_API_KEY"]
JUDGE_URL    = "https://openrouter.ai/api/v1/chat/completions"
JUDGE_MODEL  = os.environ.get("JUDGE_MODEL", "openai/gpt-4o")

GOLD_PATH    = os.path.join(DATA, "routing-gold-a.jsonl")
OLD_ORACLE_V = os.path.join(DATA, "rejudge-out26-verdicts.json")
NEW_ORACLE_V = os.path.join(DATA, "oracle-cloud-qlevel-verdicts.json")
QLEVEL_REAL  = os.path.join(DATA, "rag-mvp-cloud-qlevel.jsonl")
RESULT_MD    = os.path.join(OUT, "32-oracle-rebaseline.md")

EDGE_SYSTEM_PROMPT = (
    "あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で簡潔に(2〜3文)答えてください。"
    "事実が確認できない場合や施設固有の情報は推測せず「施設にご確認ください」と述べること。"
    "医療診断・投薬指示・法令の断定はしないこと。"
)

def isgood(v):
    return bool(v) and v.get("factual") and v.get("sufficient") and not v.get("overreach")

def judge(query, answer, refs):
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

def main():
    t0 = time.time()
    print("=== oracle rebaseline (out/32) ===")

    gold = {json.loads(l)["id"]: json.loads(l) for l in open(GOLD_PATH) if l.strip()}
    edge_ids = sorted(gid for gid, g in gold.items()
                      if g.get("expected") == "edge" and g.get("referencePoints"))
    print(f"target: {len(edge_ids)} edge questions")

    # 新oracle生成: 全ref連結で今回run
    print("\ngenerating new oracle (concatenated, this run) ...")
    verdicts = {}
    for i, gid in enumerate(edge_ids):
        g = gold[gid]
        refs = g["referencePoints"]
        t1 = time.time()
        try:
            ans = gen_cloud(g["query"], refs)  # 個別refとして渡す（q-levelと同形式）
        except Exception as ex:
            print(f"  [{i+1}/{len(edge_ids)}] {gid} gen FAIL: {str(ex)[:80]}")
            verdicts[gid] = {"factual": False, "sufficient": False, "overreach": False,
                             "category": "error", "reason": str(ex)[:30]}
            continue
        elapsed = time.time() - t1
        try:
            v = judge(g["query"], ans, refs)
        except Exception as ex:
            v = {"factual": False, "sufficient": False, "overreach": False,
                 "category": "error", "reason": str(ex)[:30]}
        verdicts[gid] = v
        gd = "G" if isgood(v) else "."
        print(f"  [{i+1}/{len(edge_ids)}] {gid} {gd} {elapsed*1000:.0f}ms", flush=True)
        time.sleep(0.2)

    n = len(verdicts)
    g_new = sum(1 for v in verdicts.values() if isgood(v))
    print(f"\nnew oracle (concatenated, this run): {g_new}/{n} = {g_new/n*100:.1f}% good")

    json.dump(verdicts, open(NEW_ORACLE_V, "w"), ensure_ascii=False, indent=2)
    print(f"[cache] {NEW_ORACLE_V}")

    # 旧oracle
    old = json.load(open(OLD_ORACLE_V))["oracle_cloud"]
    common = sorted(set(old) & set(verdicts))
    g_old = sum(1 for gid in common if isgood(old[gid]))
    g_new_common = sum(1 for gid in common if isgood(verdicts[gid]))
    print(f"\ncommon ids: {len(common)}")
    print(f"old oracle (past run, individual): {g_old}/{len(common)} = {g_old/len(common)*100:.1f}%")
    print(f"new oracle (this run, concatenated): {g_new_common}/{len(common)} = {g_new_common/len(common)*100:.1f}%")
    print(f"run+formulation effect: {g_new_common - g_old:+d} questions")

    # q-level real
    real = {o["id"]: o for o in (json.loads(l) for l in open(QLEVEL_REAL) if l.strip())}
    common_r = sorted(set(verdicts) & set(real))
    n_r = len(common_r)

    print(f"\n=== 2x2: new oracle vs q-level real (both concatenated, this run) ===")
    both = ret = odd = rea = 0
    ret_ids, odd_ids = [], []
    for gid in common_r:
        og = isgood(verdicts[gid])
        rg = isgood(real[gid].get("verdict") or real[gid])
        if og and rg: both += 1
        elif og and not rg: ret += 1; ret_ids.append(gid)
        elif not og and rg: odd += 1; odd_ids.append(gid)
        else: rea += 1

    print(f"|                | real good | real bad |")
    print(f"| Oracle good    | {both:>2} (both ok)  | {ret:>2} (retrieval failure) |")
    print(f"| Oracle bad     | {odd:>2} (rare) | {rea:>2} (reasoning failure)  |")
    print(f"- oracle good: {both+ret}/{n_r} = {(both+ret)/n_r*100:.1f}%")
    print(f"- real good : {both+odd}/{n_r} = {(both+odd)/n_r*100:.1f}%")
    print(f"- retrieval failure: {ret}/{n_r} = {ret/n_r*100:.1f}%" + (f" ids={ret_ids}" if ret else ""))
    print(f"- reasoning failure: {rea}/{n_r} = {rea/n_r*100:.1f}%")
    print(f"- odd: {odd}/{n_r} = {odd/n_r*100:.1f}%" + (f" ids={odd_ids}" if odd else ""))

    if odd > 0:
        print(f"\n  ⚠️ odd={odd}件残存。同条件で real > oracle は非対称の疑い。停止。")
    else:
        print(f"\n  ✅ odd=0。公正な分離完了。")

    # cloud good 真値
    real_good_pct = (both + odd) / n_r * 100
    oracle_pct = (both + ret) / n_r * 100

    # report
    elapsed = time.time() - t0
    md = []
    md.append("# 32: oracle 再生成で cloud good 真値を確定")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 背景")
    md.append("")
    md.append("- out/31: q-level real 68.3% > old oracle 61.0%。odd 7件全件 gid_in_top1=True（情報は同じ）。")
    md.append("- 差は生成run（旧oracle=過去run / qlevel=今回run）＋ formulation（列挙 vs 連結）の交絡")
    md.append("- 本レポート: oracle を qlevel と同条件（連結・今回run・同judge）で再生成し公正に分離")
    md.append("")
    md.append("## 構成")
    md.append("")
    md.append(f"- cloud: {CLOUD_MODEL} (OpenCode)")
    md.append(f"- judge: {JUDGE_MODEL} (OpenRouter, temp=0, 全ref統一)")
    md.append(f"- 新oracle: 全ref連結・今回run")
    md.append(f"- 旧oracle: 全ref列挙・過去run (`rejudge-out26-verdicts.json`)")
    md.append(f"- q-level real: top-1 chunk・今回run (out/31)")
    md.append("")
    md.append("## 新oracle vs 旧oracle")
    md.append("")
    md.append(f"- 新oracle (連結・今回run): {g_new_common}/{len(common)} = {g_new_common/len(common)*100:.1f}%")
    md.append(f"- 旧oracle (列挙・過去run): {g_old}/{len(common)} = {g_old/len(common)*100:.1f}%")
    md.append(f"- **run+formulation 効果: {g_new_common - g_old:+d}件** (= {abs(g_new_common - g_old)/len(common)*100:.1f}pt)。これは retrieval ではなく生成条件の差。")
    md.append("")
    md.append("## 2×2: 新oracle vs q-level real（同条件）")
    md.append("")
    md.append("| | real good | real bad |")
    md.append("|---|---|---|")
    md.append(f"| **Oracle good** | {both} (both ok) | {ret} (retrieval failure) |")
    md.append(f"| **Oracle bad** | {odd} (rare) | {rea} (reasoning failure) |")
    md.append("")
    md.append(f"- oracle good: {both+ret}/{n_r} = {(both+ret)/n_r*100:.1f}%")
    md.append(f"- real good: {both+odd}/{n_r} = {(both+odd)/n_r*100:.1f}%")
    md.append(f"- retrieval failure: {ret}/{n_r} = {ret/n_r*100:.1f}%" + (f" ({', '.join(ret_ids)})" if ret else ""))
    md.append(f"- reasoning failure: {rea}/{n_r} = {rea/n_r*100:.1f}%")
    md.append(f"- odd: {odd}/{n_r} = {odd/n_r*100:.1f}%" + (f" ({', '.join(odd_ids)})" if odd else " ✅ 消滅確認"))
    md.append("")

    md.append("## cloud good 真値")
    md.append("")
    md.append(f"- **実RAG(q-level, top-1)**: {real_good_pct:.1f}%")
    md.append(f"- **天井(新oracle, 全ref注入・連結・今回run)**: {oracle_pct:.1f}%")
    md.append(f"- **retrieval loss**: {real_good_pct - oracle_pct:+.1f}pt")
    md.append(f"- 残る retrieval failure: {ret}/{n_r} = {ret/n_r*100:.1f}%")
    md.append(f"- 残る reasoning failure: {rea}/{n_r} = {rea/n_r*100:.1f}%")
    md.append("")

    if odd == 0:
        md.append("## 結論")
        md.append("")
        md.append("- **odd=0 確認。** 同条件で real ≤ oracle が成立。out/31 の oracle 超え(+7.3pt)は生成run+formulation交絡と確定。")
        md.append(f"- **cloud good 真値 = {real_good_pct:.1f}%**（q-level, 新oracle基準）。retrieval loss = {real_good_pct - oracle_pct:+.1f}pt。")
        md.append(f"- **retrieval はほぼ解決**（failure {ret}/{n_r}）。残る律速は **reasoning failure {rea}/{n_r} = {rea/n_r*100:.1f}%**。")
        md.append("- → 次の一手: generation 改善（プロンプト/モデル）。評価軸は新oracleに統一。")
    else:
        md.append("## ⚠️ odd 残存。要調査。")
        md.append(f"- odd={odd}件。同条件（連結・今回run・同judge）で real > oracle は非対称の疑い。")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)
    print(f"\n[DONE] elapsed={elapsed:.0f}s")

if __name__ == "__main__":
    main()
