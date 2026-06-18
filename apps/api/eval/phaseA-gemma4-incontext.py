#!/usr/bin/env python3
"""Phase A (Gemma 4版): Gemma 4 26B A4B + oracle参照注入。
Phase A(gemma3:4b)と完全同条件（同77件・同参照・同プロンプト構造・参照付き採点）で
gemma3:4b の 27.3% と直接比較する。Gemma 4 が 4B の推論天井を破るかの決定的検証。

env: CF_ACCOUNT_ID, CF_API_TOKEN, OPENROUTER_API_KEY
出力: data/phaseA-gemma4-incontext-results.json
"""
import json, os, time, requests, re as _re

env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
if os.path.exists(env_path):
    for line in open(env_path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

ACC = os.environ["CF_ACCOUNT_ID"]; TOK = os.environ["CF_API_TOKEN"]
MODEL = "@cf/google/gemma-4-26b-a4b-it"
CF_API = f"https://api.cloudflare.com/client/v4/accounts/{ACC}/ai/run/{MODEL}"
ORK = os.environ.get("OPENROUTER_API_KEY", "")
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "openai/gpt-4o")
JUDGE_URL = "https://openrouter.ai/api/v1/chat/completions"

# Phase A(gemma3) と同一の EDGE_SYSTEM（公平比較）
EDGE_SYSTEM = (
    "あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で簡潔に(2〜3文)答えてください。"
    "事実が確認できない場合や施設固有の情報は推測せず「施設にご確認ください」と述べること。"
    "医療診断・投薬指示・法令の断定はしないこと。"
)

def isgood(v): return bool(v) and v.get("factual") and v.get("sufficient") and not v.get("overreach")

# Phase A(gemma3) が走った 77件と同一の対象にするため、その結果JSONの id を使う
phaseA = json.load(open("apps/api/eval/data/phaseA-incontext-results.json"))
target_ids = [it["id"] for it in phaseA["items"]]
gold = {json.loads(l)["id"]: json.loads(l) for l in open("apps/api/eval/data/routing-gold-a.jsonl") if l.strip()}

def reference_of(g):
    if g.get("answerReview") != "approved": return None
    rp = g.get("referencePoints") or []
    if rp: return rp
    return [g["answer"]] if g.get("answer") else None

targets = []
for tid in target_ids:
    g = gold[tid]; ref = reference_of(g)
    if ref: targets.append({"id": tid, "query": g["query"], "refs": ref})
print(f"対象: {len(targets)}件（Phase A gemma3 と同一集合）/ model={MODEL}")

# GEMMA4_THINKING=off で thinking 無効化（SLO-2 ≤2秒 を満たす edge 構成の品質測定）
THINKING = os.environ.get("GEMMA4_THINKING", "on").lower()

def gen(query, refs):
    ref_text = "\n".join(f"- {p}" for p in refs)
    sys_p = EDGE_SYSTEM + f"\n\n回答の参考情報（介護保険の事実）:\n{ref_text}"
    payload = {
        "messages": [{"role": "system", "content": sys_p}, {"role": "user", "content": query}],
        "max_tokens": 2048 if THINKING != "off" else 512,
    }
    if THINKING == "off":
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    try:
        r = requests.post(CF_API, headers={"Authorization": f"Bearer {TOK}"}, json=payload, timeout=120)
        r.raise_for_status()
        ch = (r.json().get("result", {}) or {}).get("choices") or []
        return (ch[0].get("message", {}).get("content", "") if ch else "").strip()
    except Exception as ex:
        print(f"  gen FAIL {ex}"); return ""

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
    t["new_answer"] = gen(t["query"], t["refs"])
    print(f"  gen [{i+1}/{len(targets)}] {t['id']}: {len(t['new_answer'])}c", flush=True)
    time.sleep(0.2)

for i, t in enumerate(targets):
    try:
        t["new_verdict"] = judge(t["query"], t["new_answer"], t["refs"]) if t["new_answer"] else None
    except Exception as ex:
        t["new_verdict"] = None; print(f"  judge FAIL {t['id']}: {ex}")
    print(f"  judge [{i+1}/{len(targets)}] {t['id']}: good={isgood(t.get('new_verdict'))}", flush=True)
    time.sleep(0.2)

n = len(targets)
new_good = sum(1 for t in targets if isgood(t.get("new_verdict")))
print(f"\n=== Phase A (Gemma4) 結果（参照注入 {n}件）===")
print(f"Gemma4 + 参照注入: {new_good}/{n} = {new_good/n*100:.1f}% good")
print(f"（比較）gemma3:4b + 参照注入: 21/77 = 27.3%")
print(f"（比較）gemma3:4b 参照なし: 0/77 = 0.0%")
out = {"n": n, "new_good": new_good, "model": MODEL,
       "items": [{"id": t["id"], "query": t["query"], "new_good": isgood(t.get("new_verdict")),
                  "new_category": (t.get("new_verdict") or {}).get("category"),
                  "answer": t.get("new_answer", "")[:200]} for t in targets]}
suffix = "" if THINKING != "off" else "-thinkoff"
outpath = f"apps/api/eval/data/phaseA-gemma4-incontext-results{suffix}.json"
json.dump(out, open(outpath, "w"), ensure_ascii=False, indent=2)
print("Save:", outpath)
