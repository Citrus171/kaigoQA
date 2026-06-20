#!/usr/bin/env python3
"""out43: Gemma 4 26B A4B (Workers AI) を think ON + prompt V2 で再測定。

out/26 の edge oracle good=36.6%（thinkOFF + prompt V1）に対し、2条件だけ変えて
公平な対称比較を取る:
  - thinking: OFF → ON（GEMMA4_THINKING=on, 既定）
  - prompt: V1（2〜3文簡潔）→ V2（参考情報の数値を省略させない, rag-mvp.py 本番採用版）
他は完全に揃える: 同41件（gold-a expected==edge）/ oracle参照注入（全referencePoints）/
gpt-4o 参照付き厳格judge（factual & sufficient & not overreach = good）。

env: CF_ACCOUNT_ID, CF_API_TOKEN, OPENROUTER_API_KEY
出力: data/phaseA-gemma4-incontext-results-edge-thinkon-v2.json
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

# prompt V2（rag-mvp.py L40-51 本番採用版を一字一句移植）。V1との差=数値省略禁止に寄せる。
EDGE_SYSTEM = (
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

def isgood(v): return bool(v) and v.get("factual") and v.get("sufficient") and not v.get("overreach")

gold = {json.loads(l)["id"]: json.loads(l) for l in open("apps/api/eval/data/routing-gold-a.jsonl") if l.strip()}

# out/26 と同一の対象集合: gold-a expected==edge（41件）
target_ids = [r["id"] for r in gold.values() if r.get("expected") == "edge"]

def reference_of(g):
    if g.get("answerReview") != "approved": return None
    rp = g.get("referencePoints") or []
    if rp: return rp
    return [g["answer"]] if g.get("answer") else None

targets = []
for tid in target_ids:
    g = gold[tid]; ref = reference_of(g)
    if ref: targets.append({"id": tid, "query": g["query"], "refs": ref})

THINKING = os.environ.get("GEMMA4_THINKING", "on").lower()
print(f"対象: {len(targets)}件（gold-a expected==edge）/ model={MODEL} / thinking={THINKING} / prompt=V2")

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
print(f"\n=== out43: Gemma4 think{'ON' if THINKING!='off' else 'OFF'} + prompt V2（oracle参照注入 {n}件）===")
print(f"新条件 (thinkON + V2): {new_good}/{n} = {new_good/n*100:.1f}% good")
print(f"（比較）out/26 thinkOFF + V1: 15/41 = 36.6% good")
print(f"差分: {new_good/n*100 - 36.6:+.1f}pt")
out = {"n": n, "new_good": new_good, "model": MODEL, "thinking": THINKING, "prompt": "V2",
       "items": [{"id": t["id"], "query": t["query"], "new_good": isgood(t.get("new_verdict")),
                  "new_category": (t.get("new_verdict") or {}).get("category"),
                  "answer": t.get("new_answer", "")[:300]} for t in targets]}
outpath = "apps/api/eval/data/phaseA-gemma4-incontext-results-edge-thinkon-v2.json"
json.dump(out, open(outpath, "w"), ensure_ascii=False, indent=2)
print("Save:", outpath)
