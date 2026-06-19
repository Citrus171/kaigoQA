#!/usr/bin/env python3
"""測定A+: cloud+RAG（参照あり）good率 — edge想定41件で deepseek-v4-flash + 参照注入。

cloud-only 7.5% に対し、同じRAGを積んだ cloud モデルの実力を測る。
edge+RAG 36.6% と同一問題集合で直接比較 → モデル能力差を分離。

env: OPENCODE_API_KEY, OPENROUTER_API_KEY
出力: data/measA-cloud-rag-edge.jsonl（逐次） / 集計は stdout
"""
import json, os, time, requests, re as _re

ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "..")
def p(*a): return os.path.join(ROOT, *a)

env_path = p("apps/api/.env")
if os.path.exists(env_path):
    for line in open(env_path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

OPENCODE_KEY = os.environ["OPENCODE_API_KEY"]
OPENCODE_URL = "https://opencode.ai/zen/go/v1/chat/completions"
CLOUD_MODEL = os.environ.get("OPENCODE_MODEL", "deepseek-v4-flash")
TIMEOUT = int(os.environ.get("OPENCODE_TIMEOUT_MS", "60000")) / 1000
ORK = os.environ["OPENROUTER_API_KEY"]
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "openai/gpt-4o")
JUDGE_URL = "https://openrouter.ai/api/v1/chat/completions"

# 測定B と同一の EDGE_SYSTEM（参照ブロックを付与＝RAG）
EDGE_SYSTEM = (
    "あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で簡潔に(2〜3文)答えてください。"
    "事実が確認できない場合や施設固有の情報は推測せず「施設にご確認ください」と述べること。"
    "医療診断・投薬指示・法令の断定はしないこと。"
)

def isgood(v): return bool(v) and v.get("factual") and v.get("sufficient") and not v.get("overreach")

gold = {json.loads(l)["id"]: json.loads(l) for l in open(p("apps/api/eval/data/routing-gold-a.jsonl")) if l.strip()}

def reference_of(g):
    if g.get("answerReview") != "approved": return None
    rp = g.get("referencePoints") or []
    if rp: return rp
    return [g["answer"]] if g.get("answer") else None

# edge想定41件のみ対象
targets = []
for tid, g in gold.items():
    if g.get("expected") != "edge":
        continue
    ref = reference_of(g)
    if ref: targets.append({"id": tid, "query": g["query"], "refs": ref,
                            "expected": g.get("expected"), "category": g.get("category")})
print(f"対象: {len(targets)}件（edge想定）/ cloud={CLOUD_MODEL}（参照あり）/ judge={JUDGE_MODEL}（参照あり）")

OUTPATH = p("apps/api/eval/data/measA-cloud-rag-edge.jsonl")
done = {}
if os.path.exists(OUTPATH):
    for l in open(OUTPATH):
        if l.strip():
            o = json.loads(l); done[o["id"]] = o
    print(f"再開: 既処理 {len(done)}件はスキップ")

def gen_cloud_with_refs(query, refs):
    ref_text = "\n".join(f"- {pt}" for pt in refs)
    sys_p = EDGE_SYSTEM + f"\n\n回答の参考情報（介護保険の事実）:\n{ref_text}"
    r = requests.post(OPENCODE_URL, headers={"Authorization": f"Bearer {OPENCODE_KEY}",
                      "Content-Type": "application/json"},
                      json={"model": CLOUD_MODEL,
                            "messages": [{"role": "system", "content": sys_p},
                                         {"role": "user", "content": query}]},
                      timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()

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
    resp = requests.post(JUDGE_URL, headers={"Authorization": f"Bearer {ORK}", "Content-Type": "application/json"},
                         json={"model": JUDGE_MODEL, "temperature": 0,
                               "messages": [{"role": "user", "content": prompt}]}, timeout=120)
    m = _re.search(r"\{[\s\S]*\}", resp.json()["choices"][0]["message"]["content"])
    o = json.loads(m.group(0))
    return {k: (o.get(k) in (True, "true")) for k in ("factual", "overreach", "sufficient")} | {
        "category": o.get("category", "ok"), "reason": str(o.get("reason", ""))}

with open(OUTPATH, "a") as fout:
    for i, t in enumerate(targets):
        if t["id"] in done:
            continue
        rec = {"id": t["id"], "expected": t["expected"], "category": t["category"], "query": t["query"],
               "model": CLOUD_MODEL, "refsInjected": True}
        t0 = time.time()
        try:
            ans = gen_cloud_with_refs(t["query"], t["refs"]); rec["genFailed"] = False
        except Exception as ex:
            ans = ""; rec["genFailed"] = True; rec["genError"] = str(ex)[:120]
            print(f"  [{i+1}/{len(targets)}] {t['id']} gen FAIL: {str(ex)[:80]}", flush=True)
        rec["answer"] = ans; rec["latencyMs"] = int((time.time() - t0) * 1000)
        try:
            rec["verdict"] = judge(t["query"], ans, t["refs"]) if ans else None
        except Exception as ex:
            rec["verdict"] = None; rec["judgeError"] = str(ex)[:120]
        rec["good"] = isgood(rec.get("verdict"))
        fout.write(json.dumps(rec, ensure_ascii=False) + "\n"); fout.flush()
        print(f"  [{i+1}/{len(targets)}] {t['id']} good={rec['good']} {rec['latencyMs']}ms", flush=True)
        time.sleep(0.2)

# 集計
rows = [json.loads(l) for l in open(OUTPATH) if l.strip()]
g = sum(1 for r in rows if r.get("good"))
n = len(rows)
print(f"\n=== 測定A+: cloud+RAG（{CLOUD_MODEL} 参照あり / gpt-4o judge）===")
print(f"edge想定41件: {g}/{n} = {g/n*100:.1f}% good")
print(f"（比較）edge: Gemma4 thinkOFF + RAG = 15/41 = 36.6%")
print(f"（比較）cloud: deepseek-v4-flash no RAG = 5/41 = 12.2%（同一質問）")
