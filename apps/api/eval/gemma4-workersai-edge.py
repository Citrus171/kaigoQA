#!/usr/bin/env python3
"""Gemma 4 26B A4B (Workers AI) で A 120件の edge答案を生成（prod実機評価）。
既存 gemma3 edge-only ファイルを雛形に edge答案だけ差し替え＝rejudge と構造完全互換。
routing/expected/answerSource は gen モデル非依存なので雛形から流用する。

必要 env（.env）: CF_ACCOUNT_ID, CF_API_TOKEN（Workers AI 権限）
出力: data/e2e-workersai-gemma4-26b-a4b-edgeonly.jsonl（10件ごと逐次フラッシュ＝中断再開可）
"""
import json, os, time, requests

# .env 読み込み
env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
if os.path.exists(env_path):
    for line in open(env_path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        os.environ.setdefault(k, v)

ACCOUNT = os.getenv("CF_ACCOUNT_ID", "")
TOKEN = os.getenv("CF_API_TOKEN", "")
MODEL = os.getenv("WORKERS_AI_EDGE_MODEL", "@cf/google/gemma-4-26b-a4b-it")
if not ACCOUNT or not TOKEN:
    raise SystemExit("CF_ACCOUNT_ID / CF_API_TOKEN が未設定（.env に追加してください）")

# eval-e2e と同一の EDGE_SYSTEM_PROMPT（公平比較のため一字一句揃える）
EDGE_SYSTEM = (
    "あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で簡潔に(2〜3文)答えてください。"
    "事実が確認できない場合や施設固有の情報は推測せず「施設にご確認ください」と述べること。"
    "医療診断・投薬指示・法令の断定はしないこと。"
)

HERE = os.path.dirname(__file__)
TEMPLATE = os.path.join(HERE, "data", "e2e-ollama-gemma3-4b-edgeonly.jsonl")
OUT = os.path.join(HERE, "data", "e2e-workersai-gemma4-26b-a4b-edgeonly.jsonl")
API = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/ai/run/{MODEL}"

template = [json.loads(l) for l in open(TEMPLATE) if l.strip()]

# 再開: 既存出力の完了 id をスキップ
done = {}
if os.path.exists(OUT):
    for l in open(OUT):
        if l.strip():
            d = json.loads(l)
            if not d["edge"].get("genFailed") and d["edge"].get("answer", "").strip():
                done[d["id"]] = d
print(f"template={len(template)}件 / 既完了={len(done)}件 / model={MODEL}")


def gen(query):
    t0 = time.time()
    try:
        r = requests.post(API, headers={"Authorization": f"Bearer {TOKEN}"}, json={
            "messages": [
                {"role": "system", "content": EDGE_SYSTEM},
                {"role": "user", "content": query},
            ],
            "max_tokens": 2048,  # thinking mode が reasoning に多くのトークンを使うため content 用に余裕を持たせる
        }, timeout=120)
        r.raise_for_status()
        body = r.json()
        result = body.get("result", {}) or {}
        # Gemma 4 は OpenAI形式 choices[].message.content。旧形式 response もフォールバック。
        ans = ""
        choices = result.get("choices")
        if choices:
            ans = (choices[0].get("message", {}) or {}).get("content", "") or ""
        if not ans:
            ans = result.get("response", "") or ""
        return ans.strip(), int((time.time() - t0) * 1000), bool(not ans)
    except Exception as ex:
        print(f"    gen FAIL: {ex}")
        return "", int((time.time() - t0) * 1000), True


results = []
for i, rec in enumerate(template):
    if rec["id"] in done:
        results.append(done[rec["id"]])
        continue
    ans, ms, failed = gen(rec["query"])
    new = dict(rec)
    new["edge"] = {
        "answer": ans, "latencyMs": ms, "genFailed": failed,
        "verdict": None, "model": f"workersai:{MODEL}",
    }
    # cloud は雛形どおり skipped 維持
    results.append(new)
    print(f"  [{i+1}/{len(template)}] {rec['id']}: {len(ans)}c {ms}ms", flush=True)
    if (i + 1) % 10 == 0:
        with open(OUT, "w") as f:
            f.write("\n".join(json.dumps(r, ensure_ascii=False) for r in results) + "\n")
    time.sleep(0.3)

with open(OUT, "w") as f:
    f.write("\n".join(json.dumps(r, ensure_ascii=False) for r in results) + "\n")
n_ok = sum(1 for r in results if not r["edge"].get("genFailed") and r["edge"].get("answer", "").strip())
print(f"\n完了: {n_ok}/{len(results)} 生成成功 → {OUT}")
print("次: EVAL_GOLD_FILE=routing-gold-a.jsonl npm run eval:rejudge -w @hybrid/api -- " + os.path.relpath(OUT, os.path.join(HERE, "..")))
