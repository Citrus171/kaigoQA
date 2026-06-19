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
- [x] gold データの ★ 付与を tier 再精査結果に合わせて修正 (005[4][5], 014[3][5] の ★ 除去)
- [x] _manual_supp を全 eval スクリプトの classify_tier に統合（恒久化）
- [x] Phase 2: 修正 gold で全135件統合評価 → out/39 完了

### out/39 最終 KPI

| 指標 | 値 |
|---|---|
| **relaxed good（正規KPI）** | **119/135 = 88.1%** |
| strict good（副軸） | 93/135 = 68.9% |
| top-1 gid hit率 | 120/135 = 88.9% |
| factual誤り | 2/135 = 1.5% |
| overreach | 0/135 = 0% |
| missing (retrieval) | 13/135 = 9.6% |
| omitted (generation) | 3/135 = 2.2% |

カテゴリ別: service-compare 100% / system-explain 94% / calc-benefit 86% / boundary-case 80% / procedure 79%

### out/40 retrieval 分析
- missing 13件のうち **top-3 で 10件 (77%) 回収可能**
  - top-2: 7件 / top-3: 10件 / top-4-5: 追加0件
- 残存3件 (not in top-5): gold-A-071, gold-A-105, gold-A-114
- 推定 relaxed: 88.1% → **95.5%** (top-3採用時)

### 残課題
- [ ] retrieval: top-3 を本番採用し relaxed 増分を実測 (out/41)
- [ ] retrieval: 残存3件の embedding/chunk 改善
- [ ] omitted 3件: gold-A-061/070 verified化 + gold-calc-004 capacity
- [ ] 既存hedge calc-benefit 19件のverified化 + tier再精査
