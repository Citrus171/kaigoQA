#!/usr/bin/env python3
"""Phase 0: In-context reference probe.
reasoning失敗16件にreferencePointsをsystem promptへ注入し、gemma3:4bで再生成→GPT-4o再採点。
目的: reasoning失敗が知識アクセス問題(a)か推論能力限界(b)かを判定。
"""
import json, time, requests, os, re as _re

# Load .env
env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
if os.path.exists(env_path):
    with open(env_path) as ef:
        for line in ef:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k not in os.environ:
                os.environ[k] = v

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
EDGE_MODEL = os.getenv("OLLAMA_GEN_MODEL", "gemma3:4b")
OPENROUTER_KEY = os.getenv("OPENROUTER_API_KEY", "")
JUDGE_MODEL = os.getenv("JUDGE_MODEL", "openai/gpt-4o")
JUDGE_URL = os.getenv("JUDGE_BASE_URL", "https://openrouter.ai/api/v1/chat/completions")
print(f"JUDGE_MODEL={JUDGE_MODEL}, key={'set' if OPENROUTER_KEY else 'MISSING'}")

EDGE_SYSTEM = (
    "あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で簡潔に(2〜3文)答えてください。"
    "事実が確認できない場合や施設固有の情報は推測せず「施設にご確認ください」と述べること。"
    "医療診断・投薬指示・法令の断定はしないこと。"
)

# Load data
with open('apps/api/eval/data/rejudge-judge-openai-gpt-4o-e2e-ollama-gemma3-4b.jsonl') as f:
    rej = [json.loads(l) for l in f if l.strip()]
with open('apps/api/eval/data/routing-gold.jsonl') as f:
    gold = [json.loads(l) for l in f if l.strip()]
gid_map = {g['id']: g for g in gold}

def is_good(v):
    return v and v.get('factual') and v.get('sufficient') and not v.get('overreach')

# Extract reasoning failures with referencePoints
targets = []
for r in rej:
    g = gid_map.get(r['id'])
    if not g or g.get('answerSource') != 'reasoning': continue
    e = r['edge']
    if e.get('genFailed') or not e.get('answer','').strip(): continue
    v = e.get('rejudge')
    if not v or is_good(v): continue
    refs = g.get('referencePoints', [])
    if not refs: continue  # only test items with reference knowledge available
    targets.append({
        'id': r['id'], 'query': r['query'],
        'refs': refs, 'old_answer': e['answer'],
        'old_verdict': v,
    })

print(f"Phase 0 targets: {len(targets)} items with referencePoints (out of 16 reasoning failures)")

# Step 1: Regenerate edge answers with in-context references
results = []
for i, t in enumerate(targets):
    ref_text = "\n".join(f"- {p}" for p in t['refs'])
    system_with_refs = EDGE_SYSTEM + f"\n\n回答の参考情報（介護保険の事実）:\n{ref_text}"

    resp = requests.post(f"{OLLAMA_URL}/api/chat", json={
        "model": EDGE_MODEL, "stream": False,
        "messages": [
            {"role": "system", "content": system_with_refs},
            {"role": "user", "content": t['query']},
        ],
    }, timeout=300)
    answer = resp.json().get("message", {}).get("content", "")
    t['new_answer'] = answer.strip()
    results.append(t)
    print(f"  [{i+1}/{len(targets)}] {t['id']}: {t['query'][:40]} -> answer {len(answer)} chars")
    time.sleep(0.5)  # rate limit

# Step 2: Judge new answers with GPT-4o
def judge_answer(question, answer):
    prompt = f"""あなたは日本の介護保険制度に精通した審査員です。利用者の質問に対するAIの回答を厳格に採点してください。

質問: {question}
AIの回答: {answer}

次のキーを持つJSONのみを返答してください（前置き・コードフェンス不要）:
{{"factual": boolean,   // 制度上の事実誤り(ハルシネーション)が無ければ true
 "overreach": boolean, // 医療診断・投薬指示・法令の断定など専門職の越権があれば true
 "sufficient": boolean,// 質問に実質的に答えられていれば true（一般論で逃げていれば false）
 "category": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated",
 "reason": "30字以内の日本語理由"}}"""

    resp = requests.post(JUDGE_URL, headers={
        "Authorization": f"Bearer {OPENROUTER_KEY}",
        "Content-Type": "application/json",
    }, json={
        "model": JUDGE_MODEL, "temperature": 0,
        "messages": [{"role": "user", "content": prompt}],
    }, timeout=120)

    text = resp.json()["choices"][0]["message"]["content"]
    m = _re.search(r'\{[\s\S]*\}', text)
    if not m: return None
    o = json.loads(m.group(0))
    return {
        "factual": o.get("factual") in (True, "true"),
        "overreach": o.get("overreach") in (True, "true"),
        "sufficient": o.get("sufficient") in (True, "true"),
        "category": o.get("category", "ok"),
        "reason": str(o.get("reason", "")),
    }

for i, t in enumerate(results):
    try:
        t['new_verdict'] = judge_answer(t['query'], t['new_answer'])
        print(f"  judge [{i+1}/{len(results)}] {t['id']}: good={is_good(t['new_verdict'])}")
    except Exception as e:
        print(f"  judge [{i+1}/{len(results)}] {t['id']}: FAILED ({e})")
        t['new_verdict'] = None
    time.sleep(0.3)

# Step 3: Compare
old_good = sum(1 for t in results if is_good(t['old_verdict']))  # should be 0
new_good = sum(1 for t in results if t['new_verdict'] and is_good(t['new_verdict']))
n = len(results)
print(f"\n=== Phase 0 Results ===")
print(f"baseline (no context): {old_good}/{n} = {old_good/n*100:.1f}% good")
print(f"in-context refs:       {new_good}/{n} = {new_good/n*100:.1f}% good")
print(f"delta: {new_good - old_good:+d} items ({'+' if new_good > old_good else ''}{(new_good-old_good)/n*100:.1f}pt)")
print()

if new_good / n >= 0.3:
    print("判定: 知識アクセス問題(a) → RAG主軸")
else:
    print("判定: 4B推論能力限界(b) → granite3.2:8b / 蒸留が必要")

# Save
out = {
    "n": n, "old_good": old_good, "new_good": new_good,
    "items": [{
        "id": t['id'], "query": t['query'],
        "old_good": is_good(t['old_verdict']),
        "new_good": t['new_verdict'] and is_good(t['new_verdict']),
        "new_reason": t['new_verdict']['reason'] if t['new_verdict'] else None,
    } for t in results],
}
with open('apps/api/eval/data/phase0-incontext-results.json', 'w') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print(f"\nSave: apps/api/eval/data/phase0-incontext-results.json")
