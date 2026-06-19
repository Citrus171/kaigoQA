# 2026-06-19 残タスク

## 状況
- out/34-36 完了。generation改善ラインは主目的達成。
- V2 prompt 本番反映済み。
- relaxed 正規KPI 確定。calc-benefit 80.0%、easy 95.1%。

## タスク

### ✅ セッション作業（全完了）
- [x] out/34: calc-benefit 20件 baseline 評価 (relaxed 55.0%)
- [x] out/35: prompt V2 効果測定 (+25pt → 80.0%, omitted 7→4)
- [x] out/36: easy 41件 V2 回帰確認 (95.1%, 回帰0, factual増加0)
- [x] V2 本番反映 (rag-mvp.py EDGE_SYSTEM)
- [x] クリーンアップ + マイルストーンコミット (bfd104d)
- [x] out/37: モデル比較 (DeepSeek 85% = Claude 85% > GPT-4o 65%)
- [x] out/38: gold tier 再精査 (005/014 降格 → omitted 5件溶解)

### out/37 結果
- deepseek-flash: 17/20 (85.0%), bad=missing1+omit2
- claude-sonnet-4: 17/20 (85.0%), bad=mis1+omit2
- gpt-4o: 13/20 (65.0%), bad=missing1+omit6
- gold-calc-005: 全3モデルとも omit → gold tier 問題と確定
- gold-calc-004/014: モデル依存で pass/omit が分かれる → borderline

### out/38 結果 (tier再精査: 005 [4][5]・014 [3][5] を supplement に降格)
- deepseek-flash: **19/20 (95.0%)** resolved=2 (005,014)
- claude-sonnet-4: **18/20 (90.0%)** resolved=1 (005)
- gpt-4o: **16/20 (80.0%)** resolved=3 (005,006,014)

残存 bad:
- gold-calc-004 (GPT-4o, Claude): 回答の質不十分 (7 main facts 詰め込めず)
- gold-calc-013 (全モデル): retrieval miss (A-084 to hit, tierでは解決不可)
- gold-calc-020 (Claude): factual 誤り (60歳退職時の解釈ミス)

### 確定事項
- **005 単位数・014 単位数+LIFE改定文脈 は supplement 降格が正当。恒久採用すべき**
- relaxed 軸の原則（質問が直接尋ねる核心の欠落のみ bad）に整合
- gold tier 問題が calc-benefit の最大の false negative 要因だった

### 次アクション
- [ ] gold データの ★ 付与を tier 再精査結果に合わせて修正 (005[5], 014[3][5] の ★ 除去)
- [ ] _manual_supp を全 eval スクリプトの classify_tier に統合（恒久化）
- [ ] 修正後の gold で rag-mvp.py 本番評価を再実行
- [ ] 既存hedge calc-benefit 19件のverified化 (優先度低)
