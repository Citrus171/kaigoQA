# 2026-06-19 残タスク

## 状況
- out/34-36 完了。generation改善ラインは主目的達成。
- V2 prompt 本番反映済み。
- relaxed 正規KPI 確定。calc-benefit 80.0%、easy 95.1%。

## タスク

### ✅ セッション作業
- [x] out/34: calc-benefit 20件 baseline 評価 (relaxed 55.0%)
- [x] out/35: prompt V2 効果測定 (+25pt → 80.0%)
- [x] out/36: easy 41件 V2 回帰確認 (95.1%, 回帰0)
- [x] V2 本番反映 (rag-mvp.py EDGE_SYSTEM)
- [ ] クリーンアップ + マイルストーンコミット
- [ ] out/37: モデル比較 (DeepSeek Flash vs GPT-4o vs Claude Sonnet)

### 未着手（次回以降）
- [ ] 残存 omitted 3件 (004/005/014) の capacity 切り分け → out/37 で対応
- [ ] 既存hedge calc-benefit 19件のverified化 (優先度低)
- [ ] gold-A-014 tier 再精査 (単位数/LIFEがsupplementの可能性)
