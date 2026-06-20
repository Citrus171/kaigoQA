#!/usr/bin/env python3
"""Phase A: Dataset-A oracle-RAG probe（out/10 を A スケールで再現）。
approved referencePoints を持つ項目に参照を in-context 注入して gemma3:4b で再生成し、
rejudge と同条件（参照付き）で GPT-4o 採点。グラウンディングが gemma3:4b の good率を
どれだけ上げるか＝知識アクセス型 vs 推論限界型の比率を A で確定する。
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
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k not in os.environ:
                os.environ[k] = v

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
EDGE_MODEL = os.getenv("OLLAMA_GEN_MODEL", "gemma3:4b")
OPENROUTER_KEY = os.getenv("OPENROUTER_API_KEY", "")
JUDGE_MODEL = os.getenv("JUDGE_MODEL", "openai/gpt-4o")
JUDGE_URL = os.getenv("JUDGE_BASE_URL", "https://openrouter.ai/api/v1/chat/completions")
print(f"EDGE={EDGE_MODEL} JUDGE={JUDGE_MODEL} key={'set' if OPENROUTER_KEY else 'MISSING'}")

EDGE_SYSTEM = (
    "あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で簡潔に(2〜3文)答えてください。"
    "事実が確認できない場合や施設固有の情報は推測せず「施設にご確認ください」と述べること。"
    "医療診断・投薬指示・法令の断定はしないこと。"
)

GOLD = 'apps/api/eval/data/routing-gold-a.jsonl'
REJ = 'apps/api/eval/data/rejudge-judge-openai-gpt-4o-e2e-ollama-gemma3-4b-edgeonly.jsonl'

def reference_of(g):
    """referencePointsOf 相当: approved のみ。referencePoints 優先、無ければ answer。"""
    if g.get('answerReview') != 'approved':
        return None
    rp = g.get('referencePoints') or []
    if rp:
        return rp
    if g.get('answer'):
        return [g['answer']]
    return None

def is_good(v):
    return bool(v) and v.get('factual') and v.get('sufficient') and not v.get('overreach')

gold = {json.loads(l)['id']: json.loads(l) for l in open(GOLD) if l.strip()}
rej = [json.loads(l) for l in open(REJ) if l.strip()]

targets = []
for r in rej:
    g = gold.get(r['id'])
    if not g:
        continue
    ref = reference_of(g)
    if not ref:
        continue  # approved 参照のある項目のみ（oracle-RAG）
    e = r['edge']
    if e.get('genFailed') or not e.get('answer', '').strip():
        continue
    targets.append({
        'id': r['id'], 'query': r['query'], 'refs': ref,
        'old_verdict': e.get('rejudge'),
    })

print(f"targets (approved参照あり): {len(targets)}件")

# Step1: 参照注入で再生成
for i, t in enumerate(targets):
    ref_text = "\n".join(f"- {p}" for p in t['refs'])
    sys_p = EDGE_SYSTEM + f"\n\n回答の参考情報（介護保険の事実）:\n{ref_text}"
    try:
        resp = requests.post(f"{OLLAMA_URL}/api/chat", json={
            "model": EDGE_MODEL, "stream": False,
            "messages": [
                {"role": "system", "content": sys_p},
                {"role": "user", "content": t['query']},
            ],
        }, timeout=300)
        t['new_answer'] = resp.json().get("message", {}).get("content", "").strip()
    except Exception as ex:
        t['new_answer'] = ""
        print(f"  gen FAIL {t['id']}: {ex}")
    print(f"  gen [{i+1}/{len(targets)}] {t['id']}: {len(t['new_answer'])}c", flush=True)
    time.sleep(0.2)

# Step2: rejudge と同条件＝参照付きで採点
def judge(question, answer, refs):
    ref_text = "\n".join(f"- {p}" for p in refs)
    prompt = f"""あなたは日本の介護保険制度に精通した審査員です。AIの回答を厳格に採点してください。

質問: {question}
正解の要点（この事実に照らして採点）:
{ref_text}

AIの回答: {answer}

次のキーを持つJSONのみを返答（前置き・コードフェンス不要）:
{{"factual": boolean,   // 正解要点に反する事実誤りが無ければ true
 "overreach": boolean, // 医療診断・投薬指示・法令の断定など越権があれば true
 "sufficient": boolean,// 正解要点に実質的に答えていれば true（一般論で逃げれば false）
 "category": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated",
 "reason": "30字以内の日本語理由"}}"""
    resp = requests.post(JUDGE_URL, headers={
        "Authorization": f"Bearer {OPENROUTER_KEY}", "Content-Type": "application/json",
    }, json={"model": JUDGE_MODEL, "temperature": 0,
             "messages": [{"role": "user", "content": prompt}]}, timeout=120)
    text = resp.json()["choices"][0]["message"]["content"]
    m = _re.search(r'\{[\s\S]*\}', text)
    if not m:
        return None
    o = json.loads(m.group(0))
    return {
        "factual": o.get("factual") in (True, "true"),
        "overreach": o.get("overreach") in (True, "true"),
        "sufficient": o.get("sufficient") in (True, "true"),
        "category": o.get("category", "ok"),
        "reason": str(o.get("reason", "")),
    }

for i, t in enumerate(targets):
    if not t['new_answer']:
        t['new_verdict'] = None
        continue
    try:
        t['new_verdict'] = judge(t['query'], t['new_answer'], t['refs'])
    except Exception as ex:
        t['new_verdict'] = None
        print(f"  judge FAIL {t['id']}: {ex}")
    print(f"  judge [{i+1}/{len(targets)}] {t['id']}: good={is_good(t.get('new_verdict'))}", flush=True)
    time.sleep(0.2)

# Step3: 比較
n = len(targets)
old_good = sum(1 for t in targets if is_good(t['old_verdict']))
new_good = sum(1 for t in targets if is_good(t.get('new_verdict')))
print("\n=== Phase A 結果（approved参照 {0}件・oracle-RAG）===".format(n))
print(f"baseline(参照なし生成): {old_good}/{n} = {old_good/n*100:.1f}% good")
print(f"参照注入生成:          {new_good}/{n} = {new_good/n*100:.1f}% good")
print(f"delta: {new_good-old_good:+d}件 ({(new_good-old_good)/n*100:+.1f}pt)")
if n:
    print("判定:", "知識アクセス問題が大きい→RAG有望(B1)" if new_good/n >= 0.30
          else "推論限界が支配的→RAG単体不足、FT検討(B2)")

out = {"n": n, "old_good": old_good, "new_good": new_good,
       "items": [{"id": t['id'], "query": t['query'],
                  "old_good": is_good(t['old_verdict']),
                  "new_good": is_good(t.get('new_verdict')),
                  "new_category": (t.get('new_verdict') or {}).get('category'),
                  "new_reason": (t.get('new_verdict') or {}).get('reason')} for t in targets]}
with open('apps/api/eval/data/phaseA-incontext-results.json', 'w') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print("\nSave: apps/api/eval/data/phaseA-incontext-results.json")
