# DeepSeek handoff #19: easy 41件で prompt V2 回帰確認 → out/36

作成 2026-06-19 / Claude → Kilo(DeepSeek)。out/35 で prompt V2 が calc-benefit を relaxed 55%→80%(+25pt, 悪化0) に改善し律速=generation policy と確定。**本番 `rag-mvp.py` の `EDGE_SYSTEM` へ V2 を反映する前の最終ゲート**として、easy 41件で V2 が回帰しないか（長文化3〜5文・数値強制が過剰回答→overreach/factual/冗長partial を誘発しないか）を確認する。

## ゴール
easy 41件を **V2 prompt で生成し直し**て2軸judge → 旧prompt baseline(out/33)と比較し、relaxed が下がらない・overreach/factual が増えないことを確認。合格なら V2 を本番反映可能と判断できる。

## 🔴 鉄則
- 変えるのは `EDGE_SYSTEM_PROMPT` のみ（out/35 と同一 V2 文面）。embed/judge/検索/モデルは out/34-35 と完全固定。
- judge は 全ref(gold)・temp=0・2軸（`build_2axis_prompt` 不変）。
- ⚠️ **oracle guard（`real > 92.7%+1` で停止）は out/36 では無効化する**。easy V2 が baseline 87.8% を超えるのは**正当な改善**であり停止理由でない（calc と違い easy は guard 不要）。代わりに factual/overreach の異常増を別途フラグ。

## 対象 easy 41件（out/33 と同一固定集合・検証済）
- `expected=="edge" and referencePoints` で動的抽出＝**41件**（gold 135件中）。新 calc20 は全て `expected=="cloud"` で**混入なし**、edge_ids は 41件で不変（Claude確認済）。ハードコード不要、out/33 の `gold-tier-judge-2axis.py` と同ロジック。
- 旧prompt verdict は `data/rejudge-2axis-verdicts.json`（41 ID, calcなし）に保存済＝id で join して件別 diff に使う。

## baseline（out/33 旧prompt easy・Claude再計算済）
| 指標 | 値 |
|---|---|
| relaxed good | 36/41 = **87.8%** |
| strict good | 13/41 = 31.7% |
| overreach | 0 |
| factual誤り | 1 |

## 変更点（`out35-calc-benefit-prompt-v2.py` のコピーに対して）
新スクリプト `apps/api/eval/out36-easy-regression-v2.py`:
1. **`EDGE_SYSTEM_PROMPT` は V2（out/35 と同一文面）**。
2. **対象を easy 41件に**: `TARGET_IDS = sorted(g for g,v in gold.items() if v.get("expected")=="edge" and v.get("referencePoints"))`（動的抽出）。
3. **出力先**: `GEN_OUT = data/rag-mvp-easy-v2.jsonl`, `RESULT_MD = out/36-easy-regression-v2.md`。
4. **embed cache `rag-corpus-embeddings-qlevel-v2.json` 再利用**（135chunk・gold不変、cache hit）。
5. **oracle guard を無効化**（上記鉄則）。
6. **bad 3分類**（out/35 と同じ `classify_bad`: missing / misinterpreted / omitted）を故障分解に追加。

## 成果物（`out/36-easy-regression-v2.md`）
1. V2 easy の relaxed / strict good 率 — baseline（relaxed 87.8% / strict 31.7%）との差分。
2. **回帰チェック**: overreach（baseline 0 → ?）・factual誤り（baseline 1 → ?）・relaxed bad の増減。
3. bad 3分類（missing / misinterpreted / omitted）の件数。
4. **件別 diff 表**: `id × 旧prompt_relaxed × V2_relaxed × 変化(改善/悪化/不変)`。旧は `rejudge-2axis-verdicts.json` から join。
5. 判定: 下記の合格条件を満たすか明記。

## 合格条件（V2 本番反映の可否判断）
- **relaxed ≥ 87.8%（悪化なし、理想は同等以上）**
- **overreach = 0 維持**
- **factual誤り ≤ 1（増加なし）**
- relaxed が悪化した個別 id があれば原因（冗長化で核心ぼやけ等）を1件ずつ記載。

## やらないこと
- system prompt 以外の変更。gold 編集。calc 20件の再評価（easy 41件のみ）。oracle guard を有効のままにすること（誤停止する）。

## 完了後（Claude）
out/36 を機械検算（relaxed 独立再計算・3分類排他性・overreach/factual増減）→ 合格なら **V2 を本番 `apps/api/eval/rag-mvp.py` の `EDGE_SYSTEM` へ反映**（Claude がユーザー承認の上で実施）。悪化があれば prompt 微調整を提案。

関連: [[poc-work-state-2026-06-19]] / [[judge-strictness-usecase-mismatch]] / [[eval-oracle-asymmetry-pitfall]] / [[deepseek-handoff-default]] / out/33 / out/35 / handoff #18
