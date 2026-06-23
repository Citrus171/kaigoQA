# abstain e2e ベースライン（2026-06-23）

## 目的

④grounding 実装後のフル pipeline（retrieval + edge生成 + cloud grounding）で
実効 FN 率（答えてしまう割合）を計測し、機械的閾値のみとの差を定量化する。

## 実行コマンド

```bash
DATABASE_URL=postgresql://app:app@localhost:5436/functest_hono \
  npm run eval:abstain:e2e -w @hybrid/api
```

edge=workersai:@cf/google/gemma-4-26b-a4b-it / cloud=opencode-go:deepseek-v4-flash

## 結果（abstain-gold 30件）

| 指標              | 値                        |
|------------------|--------------------------|
| FN_mechanical    | 93.3%（28/30件が生成帯）   |
| FN_e2e           | 86.7%（26/30件が残存FN）   |
| grounding 削減   | 6.7 pp（2件追加捕捉）       |

### 区分内訳

| 区分                | 件数 | 説明                                       |
|--------------------|-----|-------------------------------------------|
| mechanical_abstain | 2   | topScore 0.5〜0.58 帯 → 機械的 abstain     |
| grounding_abstain  | 2   | 生成帯だが grounding で abstain             |
| answered           | 26  | フル pipeline を通過してなお回答（残存 FN）   |
| general            | 0   | topScore < 0.5（該当なし）                  |

### grounding が捕捉した2件

| id           | topScore | 備考                              |
|-------------|---------|----------------------------------|
| abstain-009  | 0.5845  | 生成帯最低スコア付近               |
| abstain-017  | 0.5984  | 同上スコア帯                       |

## 解釈

### FN_e2e=86.7% の意味

- 機械的閾値（0.58）のみでは 93.3% が LLM へ渡る
- grounding を加えることで 6.7pp 削減（86.7%）
- 残存 FN 26件 = corpus にない質問でも関連チャンクで高スコアが出てしまい、
  grounding チェックでも「GROUNDED」と判定された（RAG に類似表現が存在するため）

### なぜ grounding 削減が小さいか（2件）

abstain-gold の多くは「令和6年改定の新設加算」系で、corpus（令和2-4年）に
類似チャンクが多く存在する。grounding は**回答文の文言が context に存在するか**を
判定するが、LLM が corpus から拾える類似情報で回答を組み立てると GROUNDED になる。

本質的には corpus に**正答できない質問でも corpus 内の類似情報で回答できてしまう**
ため、grounding は正確なRAGには有効だが「知識範囲外の質問」の検出には限界がある。

### 今後の改善方向

1. **閾値引き下げ**: ABSTAIN_THRESHOLD を 0.58 → 0.65 程度に上げると
   FN_mechanical が下がるが、true positive（答えられる質問）も abstain するリスクあり。
   routing-gold-a との同時計測が必要。
2. **grounding プロンプト強化**: 「corpus に記載されていない情報を含むか」を明示的に問う
   → 令和6年改定特有のキーワードに反応させる余地あり。
3. **時制チェック**: 質問に「令和6年」「最新」等が含まれる場合は abstain 優先の
   前処理フィルタを追加する。

## CI ゲート設定

- `fn_e2e_threshold_pct` デフォルト = **90%**（ベースライン 86.7% + 3.3pp 余裕）
- FN_e2e が 90% を超えたら FAIL（grounding が壊れた回帰を検知）

## 関連ファイル

- `apps/api/scripts/eval-abstain-e2e.ts`: 本測定スクリプト
- `apps/api/eval/results/eval-abstain-e2e-latest.json`: 最新測定結果
- `apps/api/src/lib/grounding.ts`: grounding チェック実装
- `eval/out/49-freshness-cap-calibration.md`: freshness 較正（関連）
