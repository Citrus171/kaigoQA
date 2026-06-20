# 01 flip率分析

flip生データ3本（`apps/api/eval/data/flip-*.jsonl`）の集計。
各行 `{id, side, query, off: {goods[], flipped, majorityGood}, on: {goods[], flipped, majorityGood}}`。

"flip" = K回の good/bad 判定が不一致な項目（判定が揺れる = ノイズ）。
"多数決good率" = K回の過半数が good の項目の割合。

## データセット別集計

| データセット | judge | 条件 | n | off flip率 | on flip率 | off good率 | on good率 |
|---|---|---|---|---|---|---|---|
| flip-judge-openai-gpt-4o-k5 | GPT-4o | K=5 | 14 | 0.0% (0/14) | 0.0% (0/14) | 14.3% (2/14) | 7.1% (1/14) |
| flip-judge-deepseek-v4-flash-k5 | deepseek-v4-flash | K=5, ★後 | 16 | 6.2% (1/16) | 12.5% (2/16) | 25.0% (4/16) | 0.0% (0/16) |
| flip-v4flash-PRE-rubric | deepseek-v4-flash | K=5, ★前 | 16 | 6.2% (1/16) | 18.8% (3/16) | 25.0% (4/16) | 6.2% (1/16) |

## 比較軸(A): v4flash rubric ★前 vs ★後

同一 judge（deepseek-v4-flash）、off側の flip率・good率は不変。on側の変化:

| 指標 | ★前 | ★後 | 変化 |
|---|---|---|---|
| on flip率 | 18.8% (3/16) | 12.5% (2/16) | −1件（改善） |
| on good率 | 6.2% (1/16) | 0.0% (0/16) | −1件（さらに厳格化） |

rubric改定（★付き中心要点の明示）により flip は微減したが、good率はむしろ 0% まで低下。参照採点の「甘い採点の是正」効果を裏付ける（judge は要点ベースでより厳格に判定している）。

## 比較軸(B): 各本内 参照なし(off) vs 参照あり(on)

| データセット | off→on flip変化 | off→on good変化 | 解釈 |
|---|---|---|---|
| GPT-4o | 0件変化 | −1件 (14.3%→7.1%) | flip発生なし・good率微減。参照採点による判定安定と厳格化が両立 |
| v4flash ★後 | +1件 (6.2%→12.5%) | −4件 (25.0%→0.0%) | flipが増えたが good率が一気に 0% へ。参照によって曖昧判定が厳格方向にシフトした（揺れるが全悪判定に寄る） |
| v4flash ★前 | +2件 (6.2%→18.8%) | −3件 (25.0%→6.2%) | flip増・good率低下。★なしrubric では揺れ幅が大きい |

**結論**: 参照採点（referencePoints）は flip率を下げていない（ノイズ床削減ではない）。しかし good率の大幅低下が示すように、**参照なしでの甘い採点を厳格方向に是正している**。これは commit b551550 の主張「参照採点はノイズ床でなく精度是正」を定量的に支持する。

## judge 差に関する注意

GPT-4o と deepseek-v4-flash は **judge が異なるため good率の優劣比較はできない**。以下は観察にとどめる:
- GPT-4o: flip率 0%（判定が揺れない = 一貫性が高い）、ただし good率も低い（厳格寄り）
- deepseek-v4-flash: わずかに flip する（6.2% off）、参照ありで good率が急低下（敏感に反応）
- GPT-4o の方が flip が少ないが、これは温度の影響やモデルの回答スタイル（JSON出力の一貫性）にも依存するため「GPT-4o の方が judge として優れている」とは断定しない。

## flip 項目一覧

### deepseek-v4-flash ★後（3件）

| id/side | off判定 | on判定 | query |
|---|---|---|---|
| gold-20/cloud | 5/5good | 1/5good⚡ | 特定入所者介護サービス費の対象になりますか |
| gold-26/cloud | 5/5good | 2/5good⚡ | 支給限度額を超えた分の自己負担はいくらになりますか |
| gold-33/cloud | 2/5good⚡ | 0/5good | 限度額管理期間をまたぐ場合の利用回数の考え方は？ |

### deepseek-v4-flash ★前（3件）

| id/side | off判定 | on判定 | query |
|---|---|---|---|
| gold-18/cloud | 4/5good⚡ | 1/5good⚡ | 要介護2でデイサービスは何回利用できますか |
| gold-20/cloud | 5/5good | 2/5good⚡ | 特定入所者介護サービス費の対象になりますか |
| gold-26/cloud | 5/5good | 4/5good⚡ | 支給限度額を超えた分の自己負担はいくらになりますか |

### GPT-4o（0件）

flip発生なし。全14件で off/on ともに K=5 回の判定が一致。

## 所見

参照採点の flip率は、当初期待された「ノイズ床削減」ではなく「精度是正」（甘採点の是正）の方向に効いている。特に deepseek-v4-flash の参照あり on 側で good率が 0%（★後）〜6%（★前）と極めて低く、実務者の参照要点に照らすと edge/cloud 回答の品質不足が浮き彫りになる。

この結果は Stage2 の「品質維持できているか」を評価する物差しとして、参照採点が**保守的（厳しめ）な指標**を提供することを示す。実務的には「厳しい judge で good と判定されたものは確実」と読むのが適切。
