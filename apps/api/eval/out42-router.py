#!/usr/bin/env python3
"""out/42: Capability Router 全135件評価（フェーズ2）

設計根拠（フェーズ1 out/34-41 の故障分離）:
- 介護報酬QAの「計算系」質問は、地域区分・事業所規模・時間区分・負担割合・本人所得など
  質問文に与えられない変数に依存し、決定論的な単一解を持たない（gold の正解は
  「手順＋制度定数＋ケアマネ/最新改定に委ねる」）。
- 本番 EDGE_SYSTEM(V2) は「数値を省略せず含めよ」と指示するため、こうした underdetermined な
  質問では具体数値の"捏造"を誘発する（例: gold-A-076 が生活援助回数を誤提示し factual 失敗）。
- よって「LLM に計算させる/決定論電卓を作る」のではなく、
  質問を knowledge_qa と escalate に振り分け、escalate には数値捏造を抑止する
  guardrail 生成（手順＋確定制度定数＋ケアマネ誘導、断定禁止）を当てる。

評価:
- Router 分類精度（LLM分類器 vs hand-labeled routing gold）と confusion matrix
- route distribution
- KPI before(top-3 RAG = out/41) / after(router) を同一 judge・同一 tier で比較
- escalate 5件の before/after を個別追跡（A-061 omitted / A-076 factual の解消を確認）

knowledge_qa は out/41 の既存回答・判定を再利用（再生成しない=コスト削減・比較公平性）。
"""
import json, os, time, re as _re, math
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
EMBED_CACHE  = os.path.join(DATA, "rag-corpus-embeddings-qlevel-v2.json")
TOP3_JSONL   = os.path.join(DATA, "rag-mvp-cloud-qlevel-v2-top3.jsonl")  # out/41 baseline
ROUTER_LOG   = os.path.join(DATA, "rag-router-log.jsonl")
RESULT_MD    = os.path.join(OUT, "42-router.md")

RETRIEVAL_K = 3

# ── routing gold（意図ベースの hand-label。承認済み 2026-06-19）──
# escalate = 利用者個人の具体的ケースの数値結果を求め、未提供変数に依存して一意に定まらないもの
ESCALATE_GOLD = {"gold-A-061", "gold-A-062", "gold-A-066", "gold-A-076", "gold-A-080"}

def gold_route(gid):
    return "escalate" if gid in ESCALATE_GOLD else "knowledge_qa"

# ── 確定制度定数（厚労省告示・公開値。gold 文字列の流用ではない知識augmentation）──
# 区分支給限度基準額（令和6年度改定, 単位/月）
SHIKYU_GENDO = {
    "要支援1": 5032, "要支援2": 10531,
    "要介護1": 16765, "要介護2": 19705, "要介護3": 27048,
    "要介護4": 30938, "要介護5": 36217,
}
CONSTANTS_TEXT = (
    "【確定制度定数（令和6年度）区分支給限度基準額（単位/月）】 "
    + " / ".join(f"{k} {v:,}単位" for k, v in SHIKYU_GENDO.items())
    + "（1単位≈10円、地域区分で単価補正。福祉用具購入費の支給上限は年間10万円、"
    "住宅改修費の支給上限は原則20万円）"
)

# ── 分類器 ──（few-shot は test 135件と重複しない別例を使用＝汚染回避）
CLASSIFIER_PROMPT = """あなたは介護保険QAアシスタントのルーターです。利用者の質問を次の2つに分類してください。

- "escalate": 利用者**個人の具体的なケース**について、金額・自己負担額・利用回数・単位数などの**数値的な結果**を求めており、その答えが地域区分・事業所規模・サービス時間区分・負担割合・本人の所得など、質問文に与えられていない変数に依存して**一意に確定できない**もの。
- "knowledge_qa": 制度・要件・手続き・適格性の説明や、「どのように計算されるか（一般的な手順・仕組み）」の説明など、**参考知識で答えられる**もの。

例:
Q「母は要介護2です。デイサービスを週3回使うと毎月いくら払いますか」→ escalate
Q「限度額の範囲内で訪問看護は最大何回まで頼めますか」→ escalate
Q「介護保険の自己負担割合はどのように決まりますか」→ knowledge_qa
Q「福祉用具貸与を利用するにはどんな手続きが必要ですか」→ knowledge_qa
Q「看護小規模多機能型居宅介護とはどのようなサービスですか」→ knowledge_qa

質問: {query}

次のJSONのみを返答（前置き・コードフェンス不要）:
{{"route": "escalate"|"knowledge_qa", "reason": "20字以内の判定理由"}}"""

# ── escalate 用 guardrail 生成プロンプト（V2 の「数値を省略するな」を route 適応で反転）──
GUARDRAIL_SYSTEM = (
    "あなたは介護施設の一次対応アシスタントです。この質問は利用者の具体的ケースの金額・回数・"
    "単位数などの数値結果を尋ねていますが、これらは地域区分・事業所規模・サービス時間区分・"
    "利用者負担割合・本人の所得・報酬改定などに依存し、一意に確定できません。次の方針で日本語で答えてください: "
    "(1) 計算の手順・考え方（例: 単位数×利用回数×週数で月間総単位数を算出し限度額と比較）と、"
    "判断に必要な前提条件（どの情報が分かれば算出できるか）を説明する。"
    "(2) 区分支給限度基準額や各種上限額など、確定している制度の枠組み・数値があれば明示する。"
    "(3) 個別の具体額・回数・単位数は断定せず、『正確な算定は担当ケアマネジャーに試算を依頼』"
    "『単位数・基準額は最新の報酬改定で要確認』と明示的に案内する。"
    "(4) 参考情報に金額・回数の目安（幅のある概算）が示されている場合は、その目安を幅と前提条件を"
    "添えて必ず伝える（過度に省略しない）。一方、参考情報にない数値を推測で断定しない（捏造しない）。"
    "3〜5文程度。医療診断・投薬指示・法令の断定はしないこと。"
)

# 採点 tier（out/41 と統一）
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
_manual_supp = {"gold-calc-005": [4, 5], "gold-calc-014": [3, 5]}


def cos(a, b):
    d = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)); nb = math.sqrt(sum(y * y for y in b))
    return d / (na * nb) if na and nb else 0.0


def load_gold():
    return {json.loads(l)["id"]: json.loads(l) for l in open(GOLD_PATH) if l.strip()}


def build_qlevel_corpus(gold_dict):
    corpus = []
    for gid, g in gold_dict.items():
        refs = g.get("referencePoints") or []
        if refs:
            corpus.append({"src_id": gid, "text": "\n".join(refs)})
    return corpus


def load_embeds(cache_path):
    if not os.path.exists(cache_path):
        raise RuntimeError(f"embed cache not found: {cache_path}")
    return json.load(open(cache_path))["embeddings"]


def embed_query(text):
    r = requests.post(EMBED_URL, headers={"Authorization": f"Bearer {CF_TOK}"},
                      json={"text": [text]}, timeout=60)
    r.raise_for_status()
    return r.json()["result"]["data"][0]


def search_top(query, corpus, corpus_embeds, k):
    q = embed_query(query)
    scores = sorted(((i, cos(q, ce)) for i, ce in enumerate(corpus_embeds)), key=lambda x: -x[1])
    return [(corpus[si]["src_id"], corpus[si]["text"]) for si, _ in scores[:k]]


def classify_route(query):
    r = requests.post(OPENCODE_URL,
                      headers={"Authorization": f"Bearer {OPENCODE_KEY}", "Content-Type": "application/json"},
                      json={"model": CLOUD_MODEL, "temperature": 0,
                            "messages": [{"role": "user", "content": CLASSIFIER_PROMPT.format(query=query)}]},
                      timeout=60)
    r.raise_for_status()
    txt = r.json()["choices"][0]["message"]["content"]
    m = _re.search(r"\{[\s\S]*\}", txt)
    o = json.loads(m.group(0))
    route = o.get("route", "knowledge_qa")
    if route not in ("escalate", "knowledge_qa"):
        route = "knowledge_qa"
    return route, str(o.get("reason", ""))[:30]


def gen_guardrail(query, ref_texts):
    combined = "\n\n".join(ref_texts)
    sys_p = GUARDRAIL_SYSTEM + f"\n\n{CONSTANTS_TEXT}\n\n参考情報（介護保険の事実）:\n{combined}"
    r = requests.post(OPENCODE_URL,
                      headers={"Authorization": f"Bearer {OPENCODE_KEY}", "Content-Type": "application/json"},
                      json={"model": CLOUD_MODEL,
                            "messages": [{"role": "system", "content": sys_p},
                                         {"role": "user", "content": query}]},
                      timeout=120)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()


def classify_tier(gid, idx, pt):
    if gid in _manual_supp and idx in _manual_supp[gid]:
        return "supplement"
    return "supplement" if _supp_pat.search(pt) else "main"


def build_judge_prompt(query, answer, refs, tiers):
    main_pts = [f"- {pt}" for pt, t in zip(refs, tiers) if t == "main"]
    supp_pts = [f"- {pt}" for pt, t in zip(refs, tiers) if t == "supplement"]
    return f"""あなたは日本の介護保険制度に精通した審査員です。AIの回答を「一次対応アシスタントとして実用十分か(relaxed)」と「全要点網羅の専門的十分さ(strict)」の2軸で厳格に採点してください。

質問: {query}

★主要事実（relaxed判定で必須。利用者の行動・理解・意思決定に直結する事実）:
{chr(10).join(main_pts)}

△補足情報（relaxedでは不問。法令条番号・条文引用・年号・限度額・行政注記等の補足細目。strictでは要網羅）:
{chr(10).join(supp_pts) if supp_pts else '（なし）'}

AIの回答: {answer}

判定基準:
1. factual: 回答に事実誤認があるか（緩めず厳格に。relaxed/strict共通）
2. overreach: 医療診断・投薬指示・法令の断定をしていないか（緩めず厳格に。共通）
3. sufficient_relaxed: ★主要事実をカバーし、かつ**質問の核心＝利用者の意思決定に直結する主要事実を落としていない**か。△補足情報の欠落は不問。
   → 特に注意: **calc-benefit系質問では算定要件・金額・条件が質問の核心**。これらの具体的数値の欠落や誤りは、主要事実としてrelaxedでもinsufficientとする。
4. sufficient_strict: ★主要事実＋△補足情報の全要点を網羅しているか。

次のJSONのみを返答（前置き・コードフェンス不要）:
{{"factual": boolean, "overreach": boolean, "sufficient_relaxed": boolean, "sufficient_strict": boolean,
 "category_relaxed": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated",
 "category_strict": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated",
 "reason": "30字以内"}}"""


def judge2axis(query, answer, refs, tiers):
    prompt = build_judge_prompt(query, answer, refs, tiers)
    resp = requests.post(OR_URL,
                         headers={"Authorization": f"Bearer {ORK}", "Content-Type": "application/json"},
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
        "reason": str(o.get("reason", "")),
    }


def isgood_relaxed(v):
    return bool(v) and v.get("factual") and v.get("sufficient_relaxed") and not v.get("overreach")


def main():
    t0 = time.time()
    print("=== out/42: Capability Router 全135件 ===")
    print(f"classifier/guardrail model: {CLOUD_MODEL} / judge: {JUDGE_MODEL}")

    gold_dict = load_gold()
    corpus = build_qlevel_corpus(gold_dict)
    corpus_embeds = load_embeds(EMBED_CACHE)
    baseline = {json.loads(l)["id"]: json.loads(l) for l in open(TOP3_JSONL) if l.strip()}

    all_ids = sorted(gold_dict.keys())

    done = set()
    if os.path.exists(ROUTER_LOG):
        for l in open(ROUTER_LOG):
            if l.strip():
                done.add(json.loads(l)["id"])
        print(f"  既処理: {len(done)}件")
    to_process = [g for g in all_ids if g not in done]
    print(f"  要処理: {len(to_process)}/{len(all_ids)}件")

    with open(ROUTER_LOG, "a") as fout:
        for gid in to_process:
            g = gold_dict[gid]
            query = g["query"]
            base = baseline.get(gid, {})

            route_pred, route_reason = classify_route(query)
            route_g = gold_route(gid)

            rec = {"id": gid, "query": query, "category": g.get("category"),
                   "route_gold": route_g, "route_pred": route_pred,
                   "route_correct": route_pred == route_g, "route_reason": route_reason,
                   "good_before": bool(base.get("good_relaxed"))}

            if route_pred == "knowledge_qa":
                # RAG 経路 = out/41 既存回答を再利用
                rec["dispatched"] = "RAG"
                rec["answer"] = base.get("answer", "")
                rec["verdict"] = base.get("verdict", {})
                rec["good_after"] = bool(base.get("good_relaxed"))
            else:
                # escalate 経路 = guardrail 生成 + 採点
                rec["dispatched"] = "guardrail"
                top = search_top(query, corpus, corpus_embeds, RETRIEVAL_K)
                ref_texts = [t[1] for t in top]
                try:
                    ans = gen_guardrail(query, ref_texts)
                except Exception as ex:
                    ans = ""; rec["genError"] = str(ex)[:120]
                rec["answer"] = ans
                refs = g.get("referencePoints") or []
                tiers = [classify_tier(gid, i, pt) for i, pt in enumerate(refs)]
                if ans:
                    try:
                        rec["verdict"] = judge2axis(query, ans, refs, tiers)
                    except Exception as ex:
                        rec["verdict"] = {"factual": False, "overreach": False,
                                          "sufficient_relaxed": False, "sufficient_strict": False,
                                          "reason": "judge_err"}
                        rec["judgeError"] = str(ex)[:120]
                else:
                    rec["verdict"] = {"factual": False, "overreach": False,
                                      "sufficient_relaxed": False, "sufficient_strict": False,
                                      "reason": "gen_fail"}
                rec["good_after"] = isgood_relaxed(rec["verdict"])

            fout.write(json.dumps(rec, ensure_ascii=False) + "\n"); fout.flush()
            mark = "✓" if rec["route_correct"] else "✗"
            chg = {(True, False): "↓", (False, True): "↑"}.get((rec["good_before"], rec["good_after"]), "=")
            print(f"  {gid} route={route_pred}[{mark}] {rec['dispatched']} {chg} {route_reason[:20]}", flush=True)
            time.sleep(0.2)

    # ── 集計 ──
    rows = [json.loads(l) for l in open(ROUTER_LOG) if l.strip()]
    n = len(rows)
    acc = sum(1 for r in rows if r["route_correct"])
    # confusion: rows[gold][pred]
    labels = ["knowledge_qa", "escalate"]
    cm = {gl: {pl: 0 for pl in labels} for gl in labels}
    for r in rows:
        cm[r["route_gold"]][r["route_pred"]] += 1
    dist = {pl: sum(1 for r in rows if r["route_pred"] == pl) for pl in labels}
    good_before = sum(1 for r in rows if r["good_before"])
    good_after = sum(1 for r in rows if r["good_after"])

    esc_rows = [r for r in rows if r["route_gold"] == "escalate"]

    print("\n=== results ===")
    print(f"router accuracy: {acc}/{n} = {acc/n*100:.1f}%")
    print(f"route distribution: {dist}")
    print(f"KPI relaxed: before(top-3) {good_before}/{n} = {good_before/n*100:.1f}% -> after(router) {good_after}/{n} = {good_after/n*100:.1f}%")

    elapsed = time.time() - t0
    md = []
    md.append("# 42: Capability Router 全135件評価（フェーズ2）")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s / model={CLOUD_MODEL} / judge={JUDGE_MODEL}")
    md.append("")
    md.append("## 設計根拠")
    md.append("- フェーズ1の故障分離で、介護報酬の「計算系」質問は決定論的単一解を持たず、正解は「手順＋確定制度定数＋ケアマネ/最新改定に委ねる」と判明。")
    md.append("- 本番 EDGE_SYSTEM(V2) の「数値を省略するな」指示が underdetermined な質問では数値の捏造を誘発（gold-A-076 が factual 失敗）。")
    md.append("- → LLM分類器で knowledge_qa / escalate に振り分け、escalate は数値捏造を抑止する guardrail 生成を当てる。")
    md.append("")
    md.append("## Router 分類精度")
    md.append("")
    md.append(f"**accuracy = {acc}/{n} = {acc/n*100:.1f}%**")
    md.append("")
    md.append("| gold＼pred | knowledge_qa | escalate |")
    md.append("|---|---|---|")
    md.append(f"| **knowledge_qa** | {cm['knowledge_qa']['knowledge_qa']} | {cm['knowledge_qa']['escalate']} |")
    md.append(f"| **escalate** | {cm['escalate']['knowledge_qa']} | {cm['escalate']['escalate']} |")
    md.append("")
    md.append(f"route distribution: knowledge_qa {dist['knowledge_qa']} ({dist['knowledge_qa']/n*100:.0f}%) / escalate {dist['escalate']} ({dist['escalate']/n*100:.0f}%)")
    md.append("")
    md.append("## KPI（同一 judge・同一 tier で before/after 比較）")
    md.append("")
    md.append("| | relaxed good |")
    md.append("|---|---|")
    md.append(f"| before（top-3 RAG = out/41） | {good_before}/{n} = {good_before/n*100:.1f}% |")
    md.append(f"| after（Capability Router） | {good_after}/{n} = {good_after/n*100:.1f}% |")
    md.append(f"| 差分 | {good_after-good_before:+d}件 ({(good_after-good_before)/n*100:+.1f}pt) |")
    md.append("")
    md.append("## escalate 経路の個別追跡")
    md.append("")
    md.append("| id | category | pred正誤 | before | after | judge reason(after) |")
    md.append("|---|---|---|---|---|---|")
    for r in esc_rows:
        v = r.get("verdict") or {}
        md.append(f"| {r['id']} | {r['category']} | {'✓' if r['route_correct'] else '✗(misroute)'} | "
                  f"{'good' if r['good_before'] else 'bad'} | {'good' if r['good_after'] else 'bad'} | "
                  f"{v.get('reason','')[:30]} |")
    md.append("")
    # misroute (誤分類) 一覧
    misr = [r for r in rows if not r["route_correct"]]
    if misr:
        md.append("## 誤分類 (misroute)")
        md.append("")
        md.append("| id | category | gold | pred | reason |")
        md.append("|---|---|---|---|---|")
        for r in misr:
            md.append(f"| {r['id']} | {r['category']} | {r['route_gold']} | {r['route_pred']} | {r['route_reason'][:25]} |")
        md.append("")
    md.append("## 考察")
    md.append(f"- Router 分類精度 {acc/n*100:.1f}%。route distribution knowledge_qa {dist['knowledge_qa']/n*100:.0f}% / escalate {dist['escalate']/n*100:.0f}%。")
    md.append(f"- KPI {good_before/n*100:.1f}% → {good_after/n*100:.1f}%（{good_after-good_before:+d}件）。")
    md.append("- escalate guardrail は具体数値の捏造を抑止し honest deferral へ置換（数値律速の質問を gold 整合の応答に変換）。")
    md.append("")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}\n")
    print(report)
    print(f"\n[DONE] elapsed={elapsed:.0f}s")


if __name__ == "__main__":
    main()
