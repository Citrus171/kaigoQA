#!/usr/bin/env python3
"""Gemma4+参照注入の保存答案を GPT-4o で再採点（OpenRouter復活後）。"""
import os, json, requests, re as _re, time
from collections import defaultdict

for line in open(os.path.join(os.path.dirname(__file__), "..", ".env")):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
ORK = os.environ["OPENROUTER_API_KEY"]

res = json.load(open("apps/api/eval/data/phaseA-gemma4-incontext-results.json"))
gold = {json.loads(l)["id"]: json.loads(l) for l in open("apps/api/eval/data/routing-gold-a.jsonl") if l.strip()}

def isgood(v):
    return bool(v) and v.get("factual") and v.get("sufficient") and not v.get("overreach")

def judge(q, a, refs):
    rt = "\n".join("- " + p for p in refs)
    prompt = (
        "あなたは日本の介護保険制度に精通した審査員です。AIの回答を厳格に採点してください。\n\n"
        "質問: " + q + "\n正解の要点（この事実に照らして採点）:\n" + rt + "\n\nAIの回答: " + a + "\n\n"
        '次のキーを持つJSONのみを返答（前置き・コードフェンス不要）:\n'
        '{"factual": boolean, "overreach": boolean, "sufficient": boolean, '
        '"category": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated", "reason": "30字以内"}'
    )
    r = requests.post("https://openrouter.ai/api/v1/chat/completions",
                      headers={"Authorization": "Bearer " + ORK, "Content-Type": "application/json"},
                      json={"model": "openai/gpt-4o", "temperature": 0, "messages": [{"role": "user", "content": prompt}]},
                      timeout=90)
    m = _re.search(r"\{[\s\S]*\}", r.json()["choices"][0]["message"]["content"])
    o = json.loads(m.group(0))
    out = {k: (o.get(k) in (True, "true")) for k in ("factual", "overreach", "sufficient")}
    out["category"] = o.get("category", "ok"); out["reason"] = str(o.get("reason", ""))
    return out

items = res["items"]; cat = defaultdict(lambda: [0, 0]); ng = 0
for i, it in enumerate(items):
    g = gold[it["id"]]; refs = g.get("referencePoints") or [g.get("answer")]
    a = it.get("answer") or ""
    try:
        v = judge(it["query"], a, refs) if a else None
    except Exception as ex:
        v = None; print("  judge FAIL", it["id"], ex)
    it["new_verdict"] = v; good = isgood(v); ng += good
    c = g["category"]; cat[c][1] += 1; cat[c][0] += good
    print(f"  [{i+1}/{len(items)}] {it['id']} good={good}", flush=True)
    time.sleep(0.15)

n = len(items)
print(f"\n=== Gemma4 + 参照注入（再採点 {n}件）===")
print(f"Gemma4+参照: {ng}/{n} = {ng/n*100:.1f}% good")
print("gemma3+参照: 21/77 = 27.3% / gemma3参照なし: 0/77 = 0.0%")
print("=== category別 ===")
for c, (gg, tt) in sorted(cat.items(), key=lambda x: -x[1][1]):
    print(f"  {c:<16} {gg}/{tt} = {gg/tt*100:.0f}%")
json.dump(res, open("apps/api/eval/data/phaseA-gemma4-incontext-results.json", "w"), ensure_ascii=False, indent=2)
print("Save: phaseA-gemma4-incontext-results.json")
