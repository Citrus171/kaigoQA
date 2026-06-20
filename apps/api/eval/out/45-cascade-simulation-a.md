# A方式カスケード シミュレーション結果

**入力**: rag-mvp-edge-out44.jsonl / rag-mvp-cloud-out44.jsonl（41件同id整列）

**カスケードロジック**: edge回答に 退化(genFailed / trim空 / length<6) または `detectRiskyAssertion`(risky) があれば cloud フォールバック、両偽なら edge 確定。

## 結果サマリ

| 指標 | 値 |
|------|-----|
| カスケード後 good 件数 | 37/41 |
| カスケード後 good 率 | 90.2% |
| 参考: edge 単体 good 率 | 90.2% |
| 参考: cloud 単体 good 率 | 85.4% |
| カスケード推定平均レイテンシ | 1.8s
| 　edge確定時の平均レイテンシ | 1.8s
| 　cloudフォールバック時平均レイテンシ | 0.0s

## フォールバック内訳

- edge 確定: **41件**（100.0%）
- cloud フォールバック: **0件**（0.0%）
  - フォールバックなし

## 損得分析

| カテゴリ | 件数 | 内容 |
|----------|------|------|
| keep-good | 37 | edge確定でgood（正答維持） |
| **keep-bad（素通りbad）** | **1** | **edge確定だがbad = A方式の構造的弱点** |
| escaped-bad | 3 | どちらもbad（不可避） |
| rescued（救済） | 0 | cloudフォールバックでbad→goodに救済 |
| spoil（エスカレ損） | 0 | cloudフォールバックでgood→badに改悪 |

### 損得分解

| 指標 | 値 |
|------|-----|
| edge 単体 good | 37件 (90.2%) |
| カスケード後 good | 37件 (90.2%) |
| ネット増減 | +0件 |
| 救済成功 | 0件 +0 good |
| エスカレ損 | 0件 -0 good |

#### 素通りbad（A方式の構造的弱点 = 退化もriskyもなくedge確定するが実はbad）

- `gold-A-030` [system-explain] "介護予防ケアマネジメントとはどんなことをするのですか..." : edge=overreach

## 全41件 判定一覧

| id | category | outcome | cascade | edge→cloud | reason |
|----|----------|---------|---------|-------------|--------|
| `gold-A-001` | system-explain | escaped-bad | edge | B→B | partial |
| `gold-A-002` | system-explain | keep-good | edge | G→G | ok |
| `gold-A-003` | system-explain | keep-good | edge | G→G | ok |
| `gold-A-004` | system-explain | keep-good | edge | G→G | ok |
| `gold-A-005` | system-explain | keep-good | edge | G→G | ok |
| `gold-A-006` | system-explain | keep-good | edge | G→G | ok |
| `gold-A-008` | system-explain | keep-good | edge | G→B | ok |
| `gold-A-009` | system-explain | keep-good | edge | G→G | ok |
| `gold-A-010` | system-explain | keep-good | edge | G→G | ok |
| `gold-A-011` | system-explain | keep-good | edge | G→G | ok |
| `gold-A-013` | system-explain | keep-good | edge | G→G | ok |
| `gold-A-014` | system-explain | keep-good | edge | G→G | ok |
| `gold-A-026` | system-explain | keep-good | edge | G→G | ok |
| `gold-A-027` | system-explain | keep-good | edge | G→G | ok |
| `gold-A-028` | system-explain | keep-good | edge | G→G | ok |
| `gold-A-029` | system-explain | escaped-bad | edge | B→B | overreach |
| `gold-A-030` | system-explain | keep-bad | edge | B→G | overreach |
| `gold-A-031` | system-explain | keep-good | edge | G→G | ok |
| `gold-A-032` | system-explain | keep-good | edge | G→G | ok |
| `gold-A-033` | system-explain | keep-good | edge | G→B | ok |
| `gold-A-037` | procedure | keep-good | edge | G→G | ok |
| `gold-A-038` | procedure | keep-good | edge | G→G | ok |
| `gold-A-039` | procedure | keep-good | edge | G→G | ok |
| `gold-A-040` | procedure | keep-good | edge | G→G | ok |
| `gold-A-041` | procedure | keep-good | edge | G→G | ok |
| `gold-A-042` | procedure | keep-good | edge | G→G | ok |
| `gold-A-060` | procedure | keep-good | edge | G→B | ok |
| `gold-A-085` | service-compare | keep-good | edge | G→G | ok |
| `gold-A-086` | service-compare | keep-good | edge | G→G | ok |
| `gold-A-087` | service-compare | keep-good | edge | G→G | ok |
| `gold-A-088` | service-compare | keep-good | edge | G→G | ok |
| `gold-A-089` | service-compare | keep-good | edge | G→G | ok |
| `gold-A-090` | service-compare | keep-good | edge | G→G | ok |
| `gold-A-091` | service-compare | keep-good | edge | G→G | ok |
| `gold-A-092` | service-compare | keep-good | edge | G→G | ok |
| `gold-A-097` | service-compare | escaped-bad | edge | B→B | overreach |
| `gold-A-098` | service-compare | keep-good | edge | G→G | ok |
| `gold-A-099` | service-compare | keep-good | edge | G→G | ok |
| `gold-A-102` | service-compare | keep-good | edge | G→G | ok |
| `gold-A-103` | boundary-case | keep-good | edge | G→G | ok |
| `gold-A-115` | boundary-case | keep-good | edge | G→G | ok |
