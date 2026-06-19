#!/usr/bin/env python3
"""ローカル品質検証: Ollama gemma4:12b（CPU）+ oracle参照注入。

目的: Workers AI の Gemma 4 26B A4B（測定B=edge想定41件で36.6%）に対し、
このPCで動く gemma4:12b がローカルでどの程度の品質を出すかを同条件で測る。
※ CPU推論のため latency は測定対象外（品質のみ）。SLO-2 はローカルでは検証不可。

Workers AI 版（phaseA-gemma4-incontext.py）とは別ファイル・別出力（Kilo の cloud+RAG 測定と非競合）。
参照注入・採点ロジックは Workers AI 版と完全同一（gpt-4o judge・参照あり）。

env: OPENROUTER_API_KEY / EVAL_SET=edge|cloud（既定=phaseA77） / GEMMA4_THINKING=on|off（既定off）
出力: data/phaseA-gemma4-local-{set}{-thinkoff}.json
"""
import json, os, time, requests, re as _re

ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "..")
def P(*a): return os.path.join(ROOT, *a)

env_path = P("apps/api/.env")
if os.path.exists(env_path):
    for line in open(env_path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434") + "/api/chat"
MODEL = os.environ.get("OLLAMA_GEN_MODEL_LOCAL", "gemma4:12b")
ORK = os.environ["OPENROUTER_API_KEY"]
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "openai/gpt-4o")
JUDGE_URL = "https://openrouter.ai/api/v1/chat/completions"
THINKING = os.environ.get("GEMMA4_THINKING", "off").lower()

# Workers AI 版と同一の EDGE_SYSTEM（公平比較）
EDGE_SYSTEM = (
    "あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で簡潔に(2〜3文)答えてください。"
    "事実が確認できない場合や施設固有の情報は推測せず「施設にご確認ください」と述べること。"
    "医療診断・投薬指示・法令の断定はしないこと。"
)

def isgood(v): return bool(v) and v.get("factual") and v.get("sufficient") and not v.get("overreach")

gold = {json.loads(l)["id"]: json.loads(l) for l in open(P("apps/api/eval/data/routing-gold-a.jsonl")) if l.strip()}
EVAL_SET = os.environ.get("EVAL_SET", "").lower()
if EVAL_SET in ("edge", "cloud"):
    target_ids = [r["id"] for r in gold.values() if r.get("expected") == EVAL_SET]
    set_label = f"gold-a expected=={EVAL_SET}"
else:
    pa = json.load(open(P("apps/api/eval/data/phaseA-incontext-results.json")))
    target_ids = [it["id"] for it in pa["items"]]
    set_label = "phaseA77"

def reference_of(g):
    if g.get("answerReview") != "approved": return None
    rp = g.get("referencePoints") or []
    if rp: return rp
    return [g["answer"]] if g.get("answer") else None

targets = []
for tid in target_ids:
    g = gold[tid]; ref = reference_of(g)
    if ref: targets.append({"id": tid, "query": g["query"], "refs": ref, "category": g.get("category")})
print(f"対象: {len(targets)}件（{set_label}）/ model={MODEL}（ローカルCPU）/ thinking={THINKING}")

def gen(query, refs):
    ref_text = "\n".join(f"- {p}" for p in refs)
    sys_p = EDGE_SYSTEM + f"\n\n回答の参考情報（介護保険の事実）:\n{ref_text}"
    payload = {
        "model": MODEL, "stream": False,
        "messages": [{"role": "system", "content": sys_p}, {"role": "user", "content": query}],
        "options": {"temperature": 0, "num_predict": 512 if THINKING == "off" else 2048},
    }
    if THINKING == "off":
        payload["think"] = False  # Ollama 0.30+ thinking 無効化
    r = requests.post(OLLAMA_URL, json=payload, timeout=600)
    r.raise_for_status()
    return (r.json().get("message", {}) or {}).get("content", "").strip()

def judge(query, answer, refs):
    ref_text = "\n".join(f"- {p}" for p in refs)
    prompt = f"""あなたは日本の介護保険制度に精通した審査員です。AIの回答を厳格に採点してください。

質問: {query}
正解の要点（この事実に照らして採点）:
{ref_text}

AIの回答: {answer}

次のキーを持つJSONのみを返答（前置き・コードフェンス不要）:
{{"factual": boolean, "overreach": boolean, "sufficient": boolean,
 "category": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated", "reason": "30字以内"}}"""
    resp = requests.post(JUDGE_URL, headers={"Authorization": f"Bearer {ORK}", "Content-Type": "application/json"},
                         json={"model": JUDGE_MODEL, "temperature": 0, "messages": [{"role": "user", "content": prompt}]}, timeout=120)
    m = _re.search(r"\{[\s\S]*\}", resp.json()["choices"][0]["message"]["content"])
    o = json.loads(m.group(0))
    return {k: (o.get(k) in (True, "true")) for k in ("factual", "overreach", "sufficient")} | {
        "category": o.get("category", "ok"), "reason": str(o.get("reason", ""))}

for i, t in enumerate(targets):
    t0 = time.time()
    try:
        t["new_answer"] = gen(t["query"], t["refs"])
    except Exception as ex:
        t["new_answer"] = ""; print(f"  gen FAIL {t['id']}: {str(ex)[:80]}")
    print(f"  gen [{i+1}/{len(targets)}] {t['id']}: {len(t['new_answer'])}c {int((time.time()-t0)*1000)}ms", flush=True)

for i, t in enumerate(targets):
    try:
        t["new_verdict"] = judge(t["query"], t["new_answer"], t["refs"]) if t["new_answer"] else None
    except Exception as ex:
        t["new_verdict"] = None; print(f"  judge FAIL {t['id']}: {ex}")
    print(f"  judge [{i+1}/{len(targets)}] {t['id']}: good={isgood(t.get('new_verdict'))}", flush=True)

n = len(targets); good = sum(1 for t in targets if isgood(t.get("new_verdict")))
print(f"\n=== ローカル gemma4:12b（{set_label} / 参照注入 {n}件 / thinking={THINKING}）===")
print(f"good率: {good}/{n} = {good/n*100:.1f}%")
print(f"（比較）Workers AI Gemma4 26B A4B thinkOFF: edge41=36.6% / 最難77=41.6%")
out = {"n": n, "good": good, "model": MODEL, "set": set_label, "thinking": THINKING,
       "items": [{"id": t["id"], "category": t.get("category"), "good": isgood(t.get("new_verdict")),
                  "verdict_cat": (t.get("new_verdict") or {}).get("category"),
                  "answer": t.get("new_answer", "")[:200]} for t in targets]}
setsfx = f"-{EVAL_SET}" if EVAL_SET in ("edge", "cloud") else "-phaseA77"
thsfx = "-thinkoff" if THINKING == "off" else ""
outpath = P(f"apps/api/eval/data/phaseA-gemma4-local{setsfx}{thsfx}.json")
json.dump(out, open(outpath, "w"), ensure_ascii=False, indent=2)
print("Save:", outpath)
