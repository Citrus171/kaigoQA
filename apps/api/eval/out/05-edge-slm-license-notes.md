# Edge SLM 商用ライセンス・日本語品質調査

調査日: 2026-06-17
情報源: Ollama Library（granite3.2, gemma3, llama3.2）、Hugging Face Granite model card、GitHub Llama 3.2 LICENSE、Google Gemma 公式ドキュメント

## 比較表

| 項目 | Granite 3.2 (IBM) | Gemma 3 (Google) | Llama 3.2 (Meta) |
|---|---|---|---|
| **パラメータサイズ** | 2B / 8B | 270M / 1B / 4B / 12B / 27B | 1B / 3B |
| **ライセンス** | Apache 2.0 | Gemma Terms of Service（独自） | Llama 3.2 Community License |
| **商用可否** | 可（無制限） | 可（許諾範囲内） | 可（MAU 7億未満） |
| **制限・禁止用途** | 特になし（Apache 2.0 の標準条件のみ） | Google 禁止利用ポリシー：違法行為、有害コンテンツ生成、詐欺目的での使用等を禁止。適用される法令の遵守が必要。 | MAU 7億超は Meta の個別許諾が必要。派生モデル名に「Llama」を含める義務。「Built with Llama」表示義務。利用許諾ポリシー（AUP）遵守。再配布時に LICENSE 同梱要。 |
| **クレジット要件** | 再配布時に元の著作権表示・ライセンス条文の同梱（Apache 2.0 標準） | 特になし（Google ブランド使用は別途制限） | 「Built with Llama」の明示、派生モデル名の先頭に「Llama」を付与、NOTICE ファイルへの著作権表示 |
| **日本語対応** | 公式サポート（12言語に含まれる） | 140以上の言語に対応（日本語を含むと推定。Gemma 2 時代から多言語性能に実績あり） | 非公式サポート（公式 8 言語に日本語は含まれず。broader collection に含まれる可能性あり） |
| **日本語品質** | 日本語ベンチマーク未確認。学習データに日本語を含むが、性能は未検証。 | 多言語ベンチマーク（Global-MMLU-Lite 4B: 57.0, Belebele 4B: 59.4）を公表。gemma3:4b は本PJの eval:e2e + eval:quality で使用実績あり。 | 日本語非公式のため品質は未知数。llama3.2:1b は本PJでデフォルト edge SLM として使用中。 |
| **Ollama可用性** | `granite3.2:2b`（1.5GB, 128K）, `granite3.2:8b`（4.9GB, 128K） | `gemma3:1b`（815MB, 32K）, `gemma3:4b`（3.3GB, 128K, 画像入力可）, `gemma3:12b`（8.1GB, 128K, 画像入力可） | `llama3.2:1b`（1.3GB, 128K）, `llama3.2:3b`（2.0GB, 128K） |
| **Longest context** | 128K | 128K（4B以上）/ 32K（1B） | 128K |
| **エコシステム活発度** | Downloads: ~438K（2025年2月リリース・比較的新しい） | Downloads: ~37.8M（非常に活発） | Downloads: ~73M（最も活発） |
| **ベンチマーク（参考）** | Granite 3.2 2B: MMLU 57.18, GSM8K 67.02, HumanEval 80.13, ArenaHard 24.86 | Gemma 3 4B: MMLU 59.6, GSM8K 38.4, HumanEval 36.0, Global-MMLU-Lite 57.0 | Ollama benchmarks グラフのみ（数値未記載） |
| **備考** | IBM 公式サポート。thinking モード制御可能。ビジネスアプリケーション用途を明示。ファインチューニングで12言語外への拡張可能。Apache 2.0 は全ライセンス中最も商用制限が少ない。 | マルチモーダル（画像入力）対応。QAT 量子化モデル提供。Cloud 推論も可能。140言語対応は全候補中最大。本PJで実績あり（eval:e2e + eval:quality）。 | 最小クラス（1B）で 128K コンテキストは特徴的。edge デバイス向けに最適化。ツール呼び出し対応。本PJデフォルトとして使用中。MAU 制限が大規模商用展開の障壁になりうる。 |

## 結論

商用デプロイに最も適格な edge 候補は **Granite 3.2**（Apache 2.0 により MAU 上限・クレジット強制がなく日本語を公式サポートし、商用制限が最も少ないため）。

ただし以下の点を注記する：

1. **Granite 3.2 の日本語実性能は未検証**：日本語が公式サポート言語と明記されているものの、本PJでの eval:e2e / eval:quality での評価実績はない。既存評価ハーネス（`OLLAMA_GEN_MODEL` 環境変数）で `granite3.2:2b` または `granite3.2:8b` の評価を実施し、llama3.2:1b / gemma3:4b の実測値と比較することが望ましい。

2. **Gemma 3 も有力な次点候補**：140言語対応・多言語ベンチマークの公表実績・本PJ での評価実績（gemma3:4b）があり、商用デプロイにも制限は少ない（Google 禁止利用ポリシーの範囲のみ）。ライセンス条項の詳細確認のため、[Gemma Terms](https://ai.google.dev/gemma/terms) の直接確認を推奨。

3. **Llama 3.2 は本PJ での評価継続に適するが、MAU 制限（7億）と日本語非公式サポートが商用展開のリスク**：大規模展開の予定がない限り問題にならないが、日本語品質の検証が必要。
