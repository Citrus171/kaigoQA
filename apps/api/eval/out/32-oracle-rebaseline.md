# 32: oracle 再生成で cloud good 真値を確定

`2026-06-19 12:38` / elapsed=385s

## 背景

- out/31: q-level real 68.3% > old oracle 61.0%。odd 7件全件 gid_in_top1=True（情報は同じ）。
- 差は生成run（旧oracle=過去run / qlevel=今回run）＋ formulation（列挙 vs 連結）の交絡
- 本レポート: oracle を qlevel と同条件（連結・今回run・同judge）で再生成し公正に分離

## 構成

- cloud: deepseek-v4-flash (OpenCode)
- judge: openai/gpt-4o (OpenRouter, temp=0, 全ref統一)
- 新oracle: 全ref連結・今回run
- 旧oracle: 全ref列挙・過去run (`rejudge-out26-verdicts.json`)
- q-level real: top-1 chunk・今回run (out/31)

## 新oracle vs 旧oracle

- 新oracle (連結・今回run): 32/41 = 78.0%
- 旧oracle (列挙・過去run): 25/41 = 61.0%
- **run+formulation 効果: +7件** (= 17.1pt)。これは retrieval ではなく生成条件の差。

## 2×2: 新oracle vs q-level real（同条件）

| | real good | real bad |
|---|---|---|
| **Oracle good** | 27 (both ok) | 5 (retrieval failure) |
| **Oracle bad** | 1 (rare) | 8 (reasoning failure) |

- oracle good: 32/41 = 78.0%
- real good: 28/41 = 68.3%
- retrieval failure: 5/41 = 12.2% (gold-A-010, gold-A-026, gold-A-037, gold-A-038, gold-A-091)
- reasoning failure: 8/41 = 19.5%
- odd: 1/41 = 2.4% (gold-A-041) — temp=0でも発生し得る生成/判定ノイズ領域。実質的に odd 消滅 ✅

## cloud good 真値

- **実RAG(q-level, top-1)**: 68.3%
- **天井(新oracle, 全ref注入・同条件)**: 78.0%
- **retrieval loss**: **-9.8pt**（公正分離後）
- 残る retrieval failure: 5/41 = 12.2%
- 残る reasoning failure: 8/41 = 19.5%

## 結論

- **odd は実質消滅（1件=2.4%、ノイズ領域）。** 同条件で real ≤ oracle が成立。out/31 の oracle 超え(+7.3pt)は生成run+formulation交絡と確定。
- **旧oracle(61.0%)→新oracle(78.0%)の +17.1pt は全件生成run+formulationの効果。** API/モデル挙動の経時変化を示唆。以降の評価軸は新oracle(`oracle-cloud-qlevel-verdicts.json`)に統一。
- **cloud good 真値 = 68.3%**（q-level, 新oracle基準）。retrieval loss = -9.8pt。
- **retrieval failure 12.2% と reasoning failure 19.5% が残存。** 両方の改善が必要だが、reasoning failure (19.5%) の方が大きい。
- → 次の一手: generation 改善（プロンプト/モデル）。retrieval の残り 12.2% は q-level で自質問を引けない 2件(gold-A-038,042) への対処（top-3 でカバー可能か）。