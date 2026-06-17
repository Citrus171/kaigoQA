# 04 Agent 割り当て方針（HANDOFF 運用）

決定日: 2026-06-17
根拠: Qwen3.7 Plus / DeepSeek V4 Pro の HANDOFF タスク①〜③ 実施結果の比較

## 割り当て

| 工程 | Agent | 役割 |
|---|---|---|
| 生成（主担当） | **DeepSeek V4 Pro** | HANDOFF を受け取り、成果物（集計・ドラフト・runbook）を一括生成 |
| 検算（レビュー） | **Qwen3.7 Plus** | 生成された成果物の数値を生データ（JSONL）と照合し、矛盾を報告 |

## 最終工程（全ケース共通）

成果物確定後、人間または別プロセスで**生データ照合**を必須とする:
- flip率 → flip JSONL の `off.flipped` / `on.flipped` を直接カウント
- offload率 → E2E JSONL の `routing.predictedTier` を直接カウント
- good率 → rejudge JSONL の `isGoodAnswer` を直接カウント

## 選定理由

今回の HANDOFF タスク（HANDOFF.md・①flip集計/②結論ドラフト/③runbook）では:

- **DeepSeek V4 Pro**: 数値の整合性チェックと最終報告の信頼性で優位。集計・要約間の矛盾がなかった。
- **Qwen3.7 Plus**: 成果物作成はできたが、要約で自身の成果物の数値を取り違えた（off/on 逆転、offload率 未確定と誤報告）。

HANDOFF の性質上、実装力より**監査力（数値整合性・要約忠実性）**が成否を決めるため、DeepSeek を主担当とする。

## 留保

今回の比較は「Qwen 17:02 → DeepSeek 17:04」の**逐次実行**であり、DeepSeek は Qwen の既存成果物を読める有利な条件だった。純粋な実力差の検証には、**別clone/別branch で同一 HANDOFF を同時に投入する AB テスト**が望ましい。

次回の HANDOFF で AB テストを実施し、本割り当てを再評価する。
