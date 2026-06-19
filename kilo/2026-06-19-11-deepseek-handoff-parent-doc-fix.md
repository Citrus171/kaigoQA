# DeepSeek handoff: approach C を公正に再実装（out/29）

作成 2026-06-19 / Claude → Kilo(DeepSeek)。
**タスク**: out/28 の approach C を、oracle と生成入力規模を揃えた公正な形で再実装する。

> ## 🔴 鉄則（最優先・必読）
> **oracle（理論上界）を real が超えたら、改善でなく評価バグ（oracleとrealの条件非対称）を疑う。**
> これは 2026-06-19 に2回連続で踏んだ罠（memory `eval-oracle-asymmetry-pitfall`）:
> - out/26: judge参照が oracle=全ref / real=retrieval参照 で非対称 → 偽の逆転。
> - out/28: 生成入力が oracle=その質問のM≈5件 / approach C=**top-20全src_idの親=平均69.7件(14.6質問分)＝14.3倍** で非対称 → 偽のoracle超え(+4.9pt)。odd=8件も全件この大量注入の産物。
> → **judgeは常に全ref固定**、**生成入力規模は必ず oracle と同オーダーに揃える**こと。

## out/28 の何が間違っていたか
`parent_document_refs`（chunk-design-cloud.py L188）が **top-20 に出現した全 src_id の親**を渡していた。top-20 には14〜19質問がヒット（≒検索が無差別）→ 生成に~70件注入。これは parent-document retrieval ではなく「大量文脈の総当たり」。実運用も非現実的（コスト/レイテンシ/ノイズ）。

## 正しい設計（out/29）
parent-document retrieval の本来形 = **検索上位の少数 chunk の親だけ**を渡す。

- **検索**: fine-grained 573 chunks（現状維持・embed cache流用、再embed不要）で top-k。
- **親の選び方**: top-k の src_id を出現順（=スコア順）に並べ、**上位 N 個の unique src_id の親文書のみ**を生成に渡す。`N ∈ {1, 2, 3}` を比較。
  - N=1: 最上位 chunk の質問の親（≈M件=oracle同等オーダー）。
  - N=2,3: 上位2〜3質問の親（生成入力 ~2〜3M）。
- **記録必須**: 各件の `n_parent_srcs` / `n_parent_refs` を出力し、レポートに**平均生成入力件数を明記**（oracle M≈4.9 と並べて非対称がないことを示す）。N=3 でも ~15件程度に収まるはず。
- judge は `rejudge-out26.py` の judge() 流用・**全ref(gold)固定**・temp=0。

## retrieval の良し悪しの正しい捉え方
この設計だと retrieval 品質 = **「その質問(gid)の親を上位 N に引けるか」**。
- top-N src_id に gid が入る → 親=自質問の全ref（oracle相当の情報）→ 推論できれば good。
- gid が入らない → 他質問の親しか渡らない → retrieval failure。
- 参考指標: 各 k,N で **top-N src_id に gid が含まれる率**（=正しい親を引けた率）を出す。これが新しい意味での recall。

## 評価
- N=1,2,3 それぞれで cloud(deepseek-v4-flash) を再生成 → 全ref judge → 2×2（oracle_cloud vs real）。
- oracle_cloud verdict = `data/rejudge-out26-verdicts.json` の `oracle_cloud`。
- **real good が oracle 61.0% を超えたら停止して報告**（再び非対称の疑い。生成入力件数を確認）。
- retrieval failure 8件（gold-A-006,013,014,027,030,038,039,042）のうち何件が救済されるか。

## 成果物
- 修正スクリプト（`chunk-design-cloud.py` の `parent_document_refs` を N 制限版に）。
- `data/rag-mvp-cloud-parentN{1,2,3}.jsonl`
- `apps/api/eval/out/29-parent-doc-fix.md`: N別の cloud good / 生成入力件数(oracleと並記) / top-N gid含有率 / 2×2 / retrieval failure 救済数 / 考察。

## やらないこと
- 生成入力を oracle より大きいオーダーにすること（out/28 の轍）。
- edge 再生成 / generation 改善 / #08（順序通り後段）。
- judge を retrieval 参照採点に戻すこと。

完了後 Claude が out/29 を機械検算（生成入力規模の対称性・2×2・救済突合）。

関連: out/26 / out/27 / out/28 / `rejudge-out26.py` / [[eval-oracle-asymmetry-pitfall]] / [[selective-routing-pivot]]
