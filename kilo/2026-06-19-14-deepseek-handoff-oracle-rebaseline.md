# DeepSeek handoff: oracle を今回run・連結形式で再生成し cloud good 真値を確定（out/32）

作成 2026-06-19 / Claude → Kilo(DeepSeek)。
**タスク**: out/31 の oracle超え(+7.3pt)交絡を解消するため、oracle を qlevel real と同条件（今回run・連結形式・同judge）で再生成し、retrieval の真の効果と cloud good 真値を確定する。

> ## 🔴 鉄則（[[eval-oracle-asymmetry-pitfall]]）
> real が oracle を超えたら停止して報告（自己判断で「許容」しない＝out/31 の運用エラーを繰り返さない）。judge は全ref(gold)・temp=0 固定。生成入力規模は oracle と同オーダー。

## なぜ必要か（out/31 検算の結論）
- chunk粒度変更で **retrieval はほぼ解決**（top-1 gid 65.9%→95.1%, retrieval failure 29.3%→9.8%）。これは確実。
- だが cloud real 68.3% > oracle 61.0% は無効。odd 7件**全件 gid_in_top1=True**（自質問hit＝oracleと同情報）なのに good。差は **生成run（旧oracle=過去run / qlevel=今回run）＋ formulation（旧oracle=個別列挙 / qlevel=連結）の交絡**で、retrieval効果ではない。
- → oracle を qlevel と**同条件**に揃えれば交絡が消え、retrieval の真の効果が出る。

## 設計
1. **新 oracle 再生成（必須）**: 各質問（edge候補41件）の**全 referencePoints を連結**（qlevel と同じ区切り）し、**今回 run の deepseek-v4-flash** に渡して生成。→ 全ref judge（gpt-4o, temp=0）。
   - これが「retrieval 完璧（全ref入手）・連結・今回run」の **cloud capability 上限**＝新基準。
   - 生成・judge は `rejudge-out26.py` / `chunk-granularity.py` の関数流用。
2. **（参考・任意）formulation 切り分け**: 同じ全refを**個別列挙**でも今回run再生成→採点。連結 vs 列挙で good 率差を見れば formulation 効果が分離できる。

## 比較と検算
- **新oracle vs qlevel real（top-1）**: 両者とも連結・今回run。差は「retrieval が自質問を引けたか」だけ → **retrieval failure / reasoning failure を公正に再分離**。odd は消えるはず（同条件なら real ≤ oracle。**もし real > 新oracle ならまた非対称＝停止報告**）。
- **新oracle vs 旧oracle（`rejudge-out26-verdicts.json` の oracle_cloud=61.0%・過去run列挙）**: 差＝生成run＋formulation効果の総量（参考値）。
- cloud good 真値 = qlevel real good を**新oracle基準**で見た値。

## 成果物
- `apps/api/eval/oracle-rebaseline.py`
- `data/oracle-cloud-qlevel-verdicts.json`（新基準 verdict。連結・今回run）
- `apps/api/eval/out/32-oracle-rebaseline.md`: 新oracle good / 旧oracleとの差（run+formulation効果）/ 新oracle vs qlevel real の 2×2（retrieval/reasoning 再分離）/ cloud good 真値 / 判定

## 重要な運用
- 以降の cloud 評価軸は **「連結・今回run」の新oracle (`oracle-cloud-qlevel-verdicts.json`)** に統一。旧 `rejudge-out26-verdicts.json` は「過去run・列挙」軸として参照のみ（混在させない＝out/27「200chunks」のような軸取り違えを避ける）。
- レポートに corpus 構成・生成run・formulation を明記。

## やらないこと
- 生成入力を oracle より大きいオーダーにする（out/28 の轍）。
- edge 再生成 / generation 改善（out/32 で軸が固まってから別 handoff）/ #08。
- judge を retrieval 参照採点に戻す。

完了後 Claude が out/32 を機械検算（新oracle good の独立再計算・新oracle vs qlevel real の 2×2・odd が消えたか・生成入力対称性）し、cloud good 真値を確定して generation 改善 handoff へ。

関連: out/26 / out/29 / out/31 / `rejudge-out26.py` / `chunk-granularity.py` / [[eval-oracle-asymmetry-pitfall]] / [[selective-routing-pivot]]
