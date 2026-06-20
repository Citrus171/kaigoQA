# セッション状態メモ（2026-06-17）

## 完了した全成果物（out/）

| # | ファイル | 内容 |
|---|---|---|
| 01 | flip-analysis.md | flip率3本集計。参照採点はflip削減でなく精度是正に効く |
| 02 | stage2-conclusion-draft.md | Stage2判定: latency -55%✅, quality loss 0.0pt✅, offload 14.7%⚠ |
| 03 | edge-eval-runbook.md | コマンドテンプレ・env一覧・命名規則 |
| 04 | agent-assignment-policy.md | DeepSeek単独＋スクリプト検算（Qwen誤報3/3で非採用） |
| 05 | edge-slm-license-notes.md | Granite3.2/Gemma3/Llama3.2 商用ライセンス比較 |
| 07 | operating-point.md | 閾値スイープ。offload率上限20.6%（loss<5pt）。推奨閾値-0.0104 |
| 08 | edge-model-comparison.md | gemma3:4b vs granite3.2:2b。2b却下（good率6.1%, loss 13pt） |
| 09 | edge-quality-improvement-plan.md | fine-tuning主軸（Phase 0で修正済み） |
| 10 | phase0-incontext-probe.md | ⭐ Phase 0実験。reasoning失敗73%は4B推論能力限界 |

## 確定した数値

| 指標 | 値 | 出典 |
|---|---|---|
| Stage2 quality loss（独立judge GPT-4o） | **0.0pt** | rejudge on gemma3:4b E2E |
| 現行offload率 | 14.7% (5/34) | 閾値 -0.0297 |
| 最大安全offload率 | 20.6% (7/34) | 07-operating-point |
| 推奨閾値 | **-0.0104** | .env に設定済み |
| gemma3:4b always-edge good率 | 29.4% (10/34) | rejudge GPT-4o |
| granite3.2:2b always-edge good率 | 6.1% (2/33) | ❌ 却下 |
| reasoning 内訳（good率） | general 37.5%, facility-data 66.7%, reasoning 5.9% | Phase 0分析 |
| flip率 | v4flash★後 off 6.2%/on 12.5% | 01-flip-analysis |
| 参照採点の効果 | flip削減→✗, 精度是正（甘採点是正）→✓ | 01 |

## Phase 0 の決定的発見

reasoning 失敗16件のうち referencePoints あり 11件で in-context 参照実験:
- baseline（参照なし）: 0/11 = 0.0%
- in-context 参照注入: 3/11 = 27.3%
- **73% (8/11) は知識を与えても gemma3:4b では解決しない → 4B 推論能力限界**

## コード変更

| ファイル | 変更内容 |
|---|---|
| eval/rejudge.ts | loadEnv() 追加（.env から OPENROUTER_API_KEY 読込） |
| eval/eval-e2e.ts | loadEnv() 追加（同上） |
| .env | AI_ROUTER_THRESHOLD="-0.0104" |
| eval/phase0-incontext-probe.py | Phase 0 実験スクリプト（再利用可） |

## 再開時の次の一手

1. **granite3.2:8b 評価（GPU環境・最優先）**
   - `ollama pull granite3.2:8b`
   - `OLLAMA_GEN_MODEL=granite3.2:8b npm run eval:e2e -w @hybrid/api`
   - rejudge GPT-4o → 動作点再探索
   - 8b が reasoning を解けば offload率 40%+ 可能

2. **RAG 詳細設計**
   - 介護保険ナレッジベース構築（法令・算定基準・Q&A）
   - bge-m3 埋め込み + コサイン類似度検索
   - edge 生成 system prompt へ注入

3. **LoRA fine-tuning（条件付き）**
   - 8b が「能力的には解けるが表現が不適切」な場合のみ価値あり
   - 4B では推論能力限界により効果薄い

## 運用ルール

- 生成: DeepSeek V4 Pro 単独
- 検算: Python ワンライナー機械照合 + 人間承認
- Qwen 非採用（レビュー誤報 3/3）
- HANDOFF は eval/out/ に .md 出力 → コミット
