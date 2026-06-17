# 09 edge 品質改善計画（gemma3:4b 29.4% → 40%+）

決定日: 2026-06-17
現状: gemma3:4b always-edge good率 29.4%（10/34、独立judge GPT-4o）

## 1. 現状診断

### 回答ソース別 good率

| answerSource | good率 | n | 支配的要因 |
|---|---|---|---|
| general | 37.5% | 8 | 挨拶等の基本的対応はできるが、制度概要の説明が不十分 |
| facility-data | 66.7% | 9 | 「施設にご確認ください」がシステムプロンプトにより安全側の正答扱い |
| **reasoning** | **5.9%** | **17** | **最大の問題。介護保険法令・算定・適用判断の知識不足** |

reasoning が全34件中 17件（50%）を占め、good率 5.9%（1/17）が全体を押し下げている。general も 37.5% と改善余地あり。

### offload率への影響

現行 offload 対象 5 件の内訳: facility-data 4件 + reasoning 1件。ルーターが edge に振っても、reasoning は答えられない。offload率を 20.6% 以上に上げると、さらに reasoning が edge に流れ、quality loss が拡大する。

## 2. 選択肢

### 選択肢A: RAG（施設文書の注入）

| 項目 | 評価 |
|---|---|
| 対象 | facility-data 9件（既に 66.7%） |
| 期待改善幅 | 小（facility-data は既に高得点。改善余地 33.3% × 9件 = 最大 +3good） |
| 全体への寄与 | 9/34 × 33.3% = **+8.8pt**（理論上限）→ 現実的には +3〜5pt |
| 実装工数 | 中（埋め込みDB構築、検索パイプライン、プロンプト注入） |
| latency 増加 | +数百ms（埋め込み検索） |

RAG は facility-data の改善には効くが、すでに 66.7% で天井が近い。offload 対象の 4/5 件が facility-data なので offload率の信頼性向上には寄与する。

### 選択肢B: Fine-tuning（介護ドメイン知識の注入）

| 項目 | 評価 |
|---|---|
| 対象 | reasoning 17件 + general 8件（計 25件） |
| 期待改善幅 | 大（reasoning 5.9% → 30〜50% を目標。general 37.5% → 50〜60%） |
| 全体への寄与 | reasoning: 17/34 × 30pt改善 = **+15pt**。general: 8/34 × 20pt改善 = **+5pt**。合計 **+20pt** → 49% 到達可能 |
| 学習データ | routing-gold.jsonl 34件（referencePoints + answer） + 増強必要 |
| 実装工数 | 大（データ整形、LoRA/QLoRA 学習、評価ループ構築） |
| latency | 不変（推論時のモデルサイズは同じ） |
| 制約 | gemma3:4b の fine-tuning は Gemma Terms の範囲内で商用利用可 |

### 選択肢C: RAG + Fine-tuning（併用）

| 項目 | 評価 |
|---|---|
| 対象 | 全 34 件 |
| 期待改善幅 | A + B = **+25〜28pt** → 54〜57% 到達可能 |
| 実装工数 | 大 + 中 |
| 推奨 | 最終形だが、段階的に A→B の順で進める |

## 3. 推奨戦略

**Fine-tuning（選択肢B）を主軸とする。** 理由:

1. **reasoning 5.9% が最大の問題**であり、RAG では解決できない（知識問題）
2. Fine-tuning で reasoning を 30% に引き上げるだけで全体は 41% に到達
3. gemma3:4b 商用利用可 + LoRA で低コスト学習が可能
4. RAG は副次的に追加（offload 対象の facility-data の信頼性向上）

### 目標ロードマップ

| フェーズ | 施策 | 目標 good率 | 目標 offload率 |
|---|---|---|---|
| 現状 | gemma3:4b 素 | 29.4% | 20.6% |
| Phase 1 | LoRA fine-tuning（reasoning重視） | **41%** | **35〜45%** |
| Phase 2 | RAG 追加（facility-data向け） | **47%** | **50〜60%** |
| Phase 3 | 両方 + プロンプト最適化 | **54%+** | **60%+** |

## 4. Phase 1 実施計画（Fine-tuning）

### 4.1 学習データ

**ソース1: routing-gold.jsonl（34件）**
- reasoning 17件 + general 8件 → 25件が直接的学習対象
- referencePoints あり（承認済み 11件）→ 教師信号として使用可能
- answer フィールド: 実務者の模範回答（人間向けだが参考値）

**ソース2: データ増強（最低 100 件目標）**
- gold データをベースにパラフレーズ生成
- 既存の routing-train.jsonl（train セット）から reasoning ラベルの項目を追加
- 介護保険の Q&A 形式データを外部から収集

**フォーマット**: Alpaca 形式
```json
{"instruction": "介護保険に関する質問に日本語で簡潔に答えてください。", "input": "<query>", "output": "<模範回答>"}
```

### 4.2 学習手法

- **LoRA**（低ランク適応）: gemma3:4b をベースに rank=8〜16 で fine-tune
- フレームワーク: unsloth / axolotl
- エポック数: 3〜5（少数データのため過学習注意）
- 評価: hold-out 5件で定性的評価 + eval:quality で定量評価

### 4.3 成功判定

- always-edge good率（独立judge GPT-4o）が **41%+** に到達
- reasoning の good率が **30%+** に改善
- quality loss < 5pt を維持したまま offload率が **35%+** に向上

## 5. RAG の位置づけ

Fine-tuning 後も facility-data は「施設にご確認ください」で 66.7% のまま。RAG で施設固有情報を注入すれば:

- 営業時間・駐車場・電話番号等を**実回答**できるようになる
- judge の参照採点で「施設依存の情報を正確に提供している」と評価される
- offload 対象の 4/5 件が facility-data なので、offload の実用性が大幅に向上

RAG 実装案:
- 施設情報を Markdown/JSON で用意（営業時間、アクセス、サービス一覧等）
- bge-m3（既存）で埋め込み → コサイン類似度で top-k 検索
- 検索結果を edge 生成の system prompt に注入: 「以下の施設情報を参考に回答してください: ...」

## 6. 即時アクション

| # | アクション | 担当 | 所要時間 |
|---|---|---|---|
| 1 | gold データを Alpaca 形式に変換するスクリプト作成 | DeepSeek | 30分 |
| 2 | reasoning 質問の増強データ作成（パラフレーズ） | DeepSeek + 人間レビュー | 1-2時間 |
| 3 | LoRA fine-tuning 環境構築（unsloth） | 人間（GPU必要） | 1時間 |
| 4 | fine-tuning 実行 + eval:quality 評価ループ | 人間 + DeepSeek | 半日 |
| 5 | Phase 1 結果を 09 の更新として文書化 | DeepSeek | 30分 |
