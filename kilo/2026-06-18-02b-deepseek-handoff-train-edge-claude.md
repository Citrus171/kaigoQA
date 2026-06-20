# HANDOFF: train-edge 拡充（centroid 被覆不足の解決）

担当: **DeepSeek V4 Pro**（生成＋自己検証）／承認: 人間（ラベル確認）／検算: Claude（build:model → eval:routing で FP 低減を測定）
作成: 2026-06-18
原版: ユーザー作成 `2026-06-18-02-deepseek-handoff-train-edge.md`（消失・復元待ち）

> ★ 本版（02b）はユーザー原版のカテゴリ指針を継承しつつ、Claude が以下の3点を修正した統合版です：
> 1. A-dev 件数: 48→**98**（実測に訂正）
> 2. FP 数値: 動作点 B/C の混線を解消し3段(A/B/C)表に差し替え
> 3. borderline: 全件 **false 固定**に変更（centroid のぼやけ防止）

## 背景・目的

Ph3 ルーティング評価（A-dev N=98, cloud=64 / edge=34, bge-m3 centroid）の結果、以下の事実が確定した：

```
┌──────────────────────┬────────┬───────────┬──────────┬──────────┐
│         段           │ Recall │ Precision │ FN(危険) │ FP(過剰) │
├──────────────────────┼────────┼───────────┼──────────┼──────────┤
│ (A) rule-base        │  9.4%  │ 100%      │ 58       │  0       │
│ (B) centroid t=0     │ 87.5%  │  81.2%    │  8       │ 13       │
│ (C) train調整 t*=−0.030│ 96.9% │  75.6%    │  2       │ 20       │
└──────────────────────┴────────┴───────────┴──────────┴──────────┘
```

**FP(edge→cloud 過剰エスカレーション) は system-explain と procedure に集中**（B: se=6/proc=5、C: se=10/proc=6/service-compare=3/boundary=1。いずれの動作点でも se+proc が支配的）。これらは edge で処理可能な一般知識クエリだが、train-edge がこれらカテゴリをカバーしていないためセントロイドが狭く、edge と認識できず誤って cloud に振られている。

**現行 train の edge ラベル内訳（7件のみ）:**
| カテゴリ | 件数 |
|---|---|
| greeting | 3 |
| general-explain | 2 |
| system-fact | 2 |
| **system-explain** | **0** ← 不足 |
| **procedure** | **0** ← 不足 |
| **service-compare** | **0** ← 不足 |

データファイル: `apps/api/eval/data/routing-train.jsonl`（24件。edge=7, cloud=17）

## タスク

**train-edge を 30件生成**し、不足カテゴリを埋める。既存 train（train-01〜train-24）に追記する形で、`routing-train.jsonl` の後続行として出力する。

### 生成件数（カテゴリ別）

| カテゴリ | 件数 | 説明 |
|---|---|---|
| **system-explain** | 14 | 介護保険制度の仕組み・用語・サービスの一般説明。SLM が一般知識のみで回答できるもの |
| **procedure** | 10 | 申請・手続き・制度利用の流れの一般説明。個別事情の判断を要さないもの |
| **service-compare** | 4 | サービス種別間の一般的な違い・使い分けの説明 |
| **general（その他）** | 2 | 上記以外で edge 適格な一般知識クエリ |
| **合計** | **30** | |

### 厳守事項

1. **全件 `label: "edge"`** — SLM（gemma3:4b 級）が介護保険の一般知識のみで適切に回答できるクエリであること
2. **全件 `answerSource: "general"`** — 施設固有情報（電話番号・営業時間・空き状況等）、具体的数値計算、個別事情の適用判断を要さないこと
3. **フォーマット** — `routing-train.jsonl` の各行と同一スキーマ:
   ```json
   {"id":"train-NN","query":"...","label":"edge","category":"<上表のいずれか>","answerSource":"general","provenance":"synthetic","reviewStatus":"pending","borderline":false}
   ```
   - `id` は `train-25` から始めて連番（train-25 〜 train-54）
   - `borderline` は**全件 `false` 固定**。train に曖昧な例を混ぜると edge centroid がぼやけ、被覆問題を悪化させる。明確に edge と言える例のみ生成すること
   - `reviewStatus` はすべて `"pending"`（人間承認待ち）
   - `provenance` はすべて `"synthetic"`

4. **金メダル（gold）のリーク禁止** — `routing-gold.jsonl`（Dataset B, 34件）および `routing-gold-a.jsonl`（Dataset A, 120件）の query 文字列と同一・酷似のクエリを絶対に生成しないこと。train は分類器の学習用、gold は held-out 評価用であり、リークすると評価が無意味になる。

5. **既存 train との重複禁止** — train-01〜train-24 の query と同一・酷似のクエリを生成しないこと。

### system-explain（14件）の方向性

Dataset A の system-explain カテゴリ（36件中 edge=約20件）を参考に、以下のような**一般知識で答えられる制度説明**を多角的にカバーする：

- 介護保険制度の基本構造（保険者・被保険者・財源の一般説明）
- サービス種別の定義・目的・対象者（一般論）
- 制度用語の定義（例: 区分支給限度基準額とは何か）
- 給付の種類と概要（一般説明、計算不要なもの）
- 事業者・施設種別の一般的役割説明

**避けるべきパターン:**
- 具体的な数値計算を要するもの（例: 「要介護3で月額いくら」）
- 法令の条文解釈を要するもの（例: 「○○法第X条の解釈」）
- 個別ケースの適用判断（例: 「私の場合は対象になりますか」）
- 施設固有情報（例: 「○○市の△△施設の料金」）

### procedure（10件）の方向性

Dataset A の procedure カテゴリ（24件中 edge=7件）を参考に、以下のような**手続きの一般フロー説明**をカバーする：

- 要介護認定の申請から結果までの標準フロー
- 各種申請に必要な書類の一般知識
- ケアプラン作成の標準的な流れ
- サービス利用開始までの標準手順
- 更新・変更の標準手続き

**避けるべきパターン:**
- 個別事情を踏まえた助言（例: 「私の家族が入院中だが…」）
- 市区町村固有の手続き（例: 「○○市での申請方法」）
- 不服申立・審査請求等の法的判断を要するもの
- 緊急時・例外時の特殊対応

### service-compare（4件）の方向性

Dataset A の service-compare カテゴリ（18件中 edge=約10件）を参考に、以下のような**サービス間の一般的比較**をカバーする：

- 類似サービス種別間の目的・対象者・提供内容の違い（一般論）
- 施設種別間の役割の違い

**避けるべきパターン:**
- 具体的な費用比較や数値比較
- 個別の施設推薦（例: 「どちらがよいか」）

### general（2件）の方向性

- 制度の理念・考え方に関する一般知識
- greeting 以外で edge 適格な軽微な問い合わせ

## 自己検証（出力前に実施必須）

成果物提出前に以下の検証を実施し、結果を添えること：

1. **件数確認**: system-explain=14, procedure=10, service-compare=4, general=2 の計30件であること
2. **スキーマ検証**: 全件が trainSchema（`label: "edge"`, `answerSource: "general"` など必須フィールド完備）に適合すること
3. **重複チェック**: 既存 train（train-01〜train-24）のいずれの query 文字列とも一致しないこと
4. **リークチェック**: `routing-gold.jsonl`（34件）および `routing-gold-a.jsonl`（120件）の query 文字列と類似していないこと（部分一致・言い換え含む）
5. **カテゴリ妥当性**: 各クエリの category が内容と整合していること
6. **edge 適格性**: 各クエリが施設固有情報・具体的数値計算・個別適用判断を要さず、介護保険の一般知識のみで回答可能であること

## 成果物形式

1. **`apps/api/eval/out/16-train-edge-candidates.jsonl`** として出力する（人間承認後に train へマージ。承認前に tracked な train を汚さない）。
   - 30行の JSONL。各行は1行JSON、改行区切り
   - `id` は `train-25` 〜 `train-54`
2. **自己検証結果** を同じ返信に含める（下記6項目の合否）

## 後続フロー（人間・Claude）

```
train-edge 生成 → 人間がラベル確認・承認
  → reviewStatus を approved に更新
  → npm run build:model -w @hybrid/api（bge-m3 centroid 再計算）
  → npm run eval:routing -w @hybrid/api（A-dev で再評価）
  → FP が 20→? に減少したか測定
  → 効果あれば A-holdout で最終確認
```

## 参考: プロジェクト構造

| パス | 役割 |
|---|---|
| `apps/api/eval/data/routing-train.jsonl` | 分類器セントロイド構築用（24件→54件に拡充予定） |
| `apps/api/eval/data/routing-gold.jsonl` | Dataset B（34件、held-out評価用） |
| `apps/api/eval/data/routing-gold-a.jsonl` | Dataset A（120件、本番分布） |
| `apps/api/eval/data/routing-gold-a-dev.jsonl` | A-dev（98件、閾値決定用 split） |
| `apps/api/eval/data/routing-gold-a-holdout.jsonl` | A-holdout（22件、最終確認用 split・凍結） |
| `apps/api/eval/data/load.ts` | データローダー＋スキーマ定義（`trainSchema`） |
| `apps/api/scripts/build-routing-model.ts` | モデルビルドスクリプト（`npm run build:model`） |
| `apps/api/eval/eval-routing.ts` | ルーティング評価スクリプト（`npm run eval:routing`） |
