# freshness cap 較正結果（2026-06-23）

## 目的

`applyFreshness` の `FRESHNESS_PENALTY_CAP=0.3` が routing-gold-a の正答率に与える影響を定量化し、現在値の妥当性を確認する。

## 実行コマンド

```bash
DATABASE_URL=postgresql://app:app@localhost:5436/functest_hono \
  npm run eval:freshness:sweep -w @hybrid/api
```

## 結果（approved 77件、FRESHNESS_PENALTY_FULL_YEARS=20）

| cap  | 変化計 | superseded | freshness_penalty | yearDeltaAvg |
|------|--------|------------|-------------------|--------------|
| 0.1  | 4      | 2          | 2                 | N/A          |
| 0.2  | 4      | 2          | 2                 | N/A          |
| 0.3  | 4      | 2          | 2                 | N/A  ← 現在値 |
| 0.4  | 4      | 2          | 2                 | N/A          |
| 0.5  | 4      | 2          | 2                 | N/A          |

## 解釈

**cap を 0.1〜0.5 のどこに設定しても、gold 正答率への影響は変わらない。**

### superseded=2（cap 非依存）

cosine top-1 チャンクに「削除/廃止/追補版の修正」マーカーが含まれていたため、`isSuperseded` フィルタで除外された変化。cap と無関係。

### freshness_penalty=2（cap 非依存）

cap=0.1 でも cap=0.5 でも同じ 2件が変化する。これは：

- `yearDeltaAvg=N/A`：両チャンクとも `extractYear` が null → `freshnessPenalty=0` → `finalScore=cosine`
- つまり **鮮度ペナルティではなく別の要因**で順位変動している可能性が高い
  - 推測: `isSuperseded` フィルタで hits[1] 等が除外されたことで hits 長が変わり、インデックスシフトが起きた
  - または date フォーマットが extractYear 対象外（和暦以外・記載なし）で year=null

### 結論

cap=0.3 は corpus に対して **実質中立**。0.2 に下げても 0.4 に上げても gold クエリの top-1 チャンクは変わらない。現在値を維持する根拠が数値で裏付けられた。

cap を意味のある値にするには、`extractYear` が有効な年を返す（≠null）チャンクが cosine top-1 に来るクエリが必要。現 corpus（令和2-4年の mhlw Q&A）は年差が小さく（最大 4年）、cap=0.3/FULL_YEARS=20 の線形ペナルティは微小（最大 0.06）にとどまる。

### 今後の calibration トリガー

- 平成年代チャンク（2000年代）が corpus に追加された場合 → cap 効果が顕在化する可能性
- `applyFreshness` の適用スコープが変わった場合

## 関連ファイル

- `apps/api/src/lib/freshness.ts`: `FRESHNESS_PENALTY_CAP`, `FRESHNESS_PENALTY_FULL_YEARS`
- `apps/api/scripts/eval-freshness-cap-sweep.ts`: 本測定スクリプト
- `apps/api/scripts/eval-freshness.ts`: 通常 nightly 測定（単一 cap=0.3）
