# 11 granite3.2:8b GPU 評価手順（RunPod フロー）

作成: 2026-06-17
前提: Phase 0 で gemma3:4b の reasoning 失敗 73% は推論能力限界と判明。
      8B クラスで reasoning が解けるかが Stage2 の次の意思決定点。

## 0. 設計方針（教訓）

| # | ルール | 理由 |
|---|---|---|
| 1 | **Secure Cloud のみ** | Community Pod は信頼性不足。前回教訓 |
| 2 | **生成と judge を分離** | 自己採点バイアス回避。生成=GPU側/Cloud、judge=OpenRouter GPT-4o 独立 |
| 3 | **tmux 必須** | SSH 切断で eval:e2e（30分〜1時間）が死ぬのを防ぐ |
| 4 | **JSONL 転送は md5 照合** | 34件×2回答の出力を転送ミスなしで引き継ぐ |
| 5 | **キーは env 注入・コードに書かない** | OPENCODE_API_KEY / OPENROUTER_API_KEY は .env 経由 |
| 6 | **pod 停止忘れず** | 評価終了後即停止。課金継続防止 |

## 1. Pod 構成

| 項目 | 値 |
|---|---|
| タイプ | RunPod Secure Cloud |
| GPU | 1× RTX 4090 以上（8B モデル + bge-m3 埋め込み用） |
| VRAM | 24GB+ |
| ディスク | 50GB+（モデル 4.9GB + リポジトリ + JSONL） |
| テンプレート | `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04` |
| 割り当て時間 | 2時間（余裕を持って） |

## 2. 環境構築（pod 内・tmux 内で実行）

```bash
# 2.1 tmux セッション開始
tmux new -s eval8b

# 2.2 Ollama インストール & 起動
curl -fsSL https://ollama.com/install.sh | sh
ollama serve &
sleep 5

# 2.3 モデル pull
ollama pull granite3.2:8b
ollama pull bge-m3

# 2.4 リポジトリ clone & セットアップ
git clone <REPO_URL> /workspace/functest-hybrid
cd /workspace/functest-hybrid
npm install

# 2.5 環境変数（.env に直接書き込む）
cat > apps/api/.env << 'EOF'
OPENCODE_API_KEY=<YOUR_OPENCODE_KEY>
OPENROUTER_API_KEY=<YOUR_OPENROUTER_KEY>
OLLAMA_GEN_MODEL=granite3.2:8b
OLLAMA_URL=http://localhost:11434
AI_ROUTER_THRESHOLD=-0.0104
EOF
```

## 3. 生成フェーズ（pod 内・tmux 内）

```bash
# 3.1 E2E 評価実行（edge=granite3.2:8b / cloud=deepseek-v4-pro）
# 所要時間目安: 34問 × (8b生成 10-15s + cloud生成 3-5s + judge 2-3s) ≒ 10-15分
cd /workspace/functest-hybrid
OLLAMA_GEN_MODEL=granite3.2:8b npm run eval:e2e -w @hybrid/api

# 出力:
#   apps/api/eval/data/e2e-ollama-granite3-2-8b.jsonl
#   標準出力にポリシー別 good率（自己採点・参考値）が表示される
#   自己採点は cloud と同一 deepseek のため過大評価注意
```

## 4. 転送フェーズ（ローカル側で実行）

```bash
# 4.1 pod から JSONL を取得
POD_ID=<YOUR_POD_ID>
scp root@${POD_ID}-22.runpod.io:/workspace/functest-hybrid/apps/api/eval/data/e2e-ollama-granite3-2-8b.jsonl \
    apps/api/eval/data/

# 4.2 md5 照合（転送破損防止）
# pod 側:
md5sum /workspace/functest-hybrid/apps/api/eval/data/e2e-ollama-granite3-2-8b.jsonl
# ローカル側:
md5sum apps/api/eval/data/e2e-ollama-granite3-2-8b.jsonl
# → 一致を確認

# 4.3 pod 停止（忘れずに）
# RunPod 管理画面または API から Stop Pod
```

## 5. judge フェーズ（ローカルで実行・GPU 不要）

```bash
# 5.1 独立 judge（GPT-4o、OpenRouter）で再採点
# .env に OPENROUTER_API_KEY が設定済みであること
npm run eval:rejudge -w @hybrid/api \
  -- /home/ubuntu1/projects/kaigo_api/functest-hybrid/apps/api/eval/data/e2e-ollama-granite3-2-8b.jsonl

# 出力:
#   apps/api/eval/data/rejudge-judge-openai-gpt-4o-e2e-ollama-granite3-2-8b.jsonl
#   標準出力にポリシー別 good率（独立judge）が表示される
```

## 6. 分析フェーズ（ローカル）

```bash
# 6.1 機械検算（Python ワンライナー）
python3 << 'PYEOF'
import json
with open('apps/api/eval/data/rejudge-judge-openai-gpt-4o-e2e-ollama-granite3-2-8b.jsonl') as f:
    lines = [json.loads(l) for l in f if l.strip()]
def is_good(v):
    return v and v.get('factual') and v.get('sufficient') and not v.get('overreach')
def j(g):
    return not g.get('skipped') and not g.get('genFailed') and g['answer'].strip() != '' and g.get('rejudge')
for label, fn in [
    ('always-edge', lambda r: r['edge']),
    ('always-cloud', lambda r: r['cloud']),
    ('routed', lambda r: r[r['routing']['predictedTier']]),
]:
    good = sum(1 for r in lines if j(fn(r)) and is_good(fn(r)['rejudge']))
    n = sum(1 for r in lines if j(fn(r)) and fn(r)['rejudge'])
    print(f'{label}: good={good}/{n} = {good/n*100:.1f}%' if n else f'{label}: N/A')
ac_g = sum(1 for r in lines if j(r['cloud']) and is_good(r['cloud']['rejudge']))
ac_n = sum(1 for r in lines if j(r['cloud']) and r['cloud']['rejudge'])
ro_g = sum(1 for r in lines if j(r[r['routing']['predictedTier']]) and is_good(r[r['routing']['predictedTier']]['rejudge']))
ro_n = sum(1 for r in lines if j(r[r['routing']['predictedTier']]) and r[r['routing']['predictedTier']]['rejudge'])
loss = (ac_g/ac_n - ro_g/ro_n) * 100 if ac_n and ro_n else float('nan')
print(f'quality loss: {loss:.1f}pt')
# offload
edg = sum(1 for r in lines if r['routing']['predictedTier']=='edge')
print(f'offload率: {edg}/{len(lines)} = {edg/len(lines)*100:.1f}%')
PYEOF

# 6.2 動作点再探索（閾値スイープ）
python3 apps/api/eval/phase0-incontext-probe.py  # 8b 向けに改造
```

## 7. 判定基準

| 指標 | 閾値 | 8b 達成目標 |
|---|---|---|
| always-edge good率 | — | **30%+**（gemma3:4b 超え） |
| quality loss | < 5pt | **< 5pt**（Stage2 維持） |
| reasoning edge good率 | — | **20%+**（4b の 5.9% から大幅改善） |
| offload率上限 | — | **30%+**（4b の 20.6% 超過） |

## 8. 結果に応じた次の一手

| 結果 | 次の一手 |
|---|---|
| 8b good率 > 35%, loss < 5pt | 8b 採用確定。閾値再調整で offload率最大化。RAG でさらに上積み |
| 8b good率 30-35%, loss 5-10pt | 8b 閾値調整次第。loss 次第で RAG or fine-tuning 追加 |
| 8b good率 < 30% | 8b でも推論能力不足。granite3.2:8b→gemma3:12b 検討 or 蒸留 |

## 9. トラブルシューティング

| 症状 | 対処 |
|---|---|
| Ollama が GPU 認識しない | `nvidia-smi` 確認。`ollama serve` 再起動 |
| eval:e2e が途中停止 | tmux 内で実行しているか確認。OPENCODE_TIMEOUT_MS=120000 に延長 |
| cloud generation 失敗 | OPENCODE_API_KEY が .env で設定されているか。`grep OPENCODE apps/api/.env` |
| JSONL が不完全 | md5 不一致なら再転送。34 行あるか `wc -l` で確認 |
| 自己採点と独立 judge の不一致が大きい | 想定内。独立judge を信用。自己採点は参考値 |
