# DeepSeek handoff #18: calc-benefit generation改善（system prompt V2）→ out/35

作成 2026-06-19 / Claude → Kilo(DeepSeek)。out/34 の結論「**generation が calc-benefit の律速**（relaxed 55.0% / retrieval は top-1 gid hit 95% で健全、真の retrieval failure は 1件のみ）」を受け、**数値省略と『施設にご確認』逃げを是正する system prompt V2** の効果を、out/34 と完全同一基盤で測定する。

## ゴール
変えるのは **system prompt のみ**。これだけで relaxed good がどこまで戻るかを測定し、calc-benefit の新律速が
- **generation policy**（逃げ・要約し過ぎ＝prompt で直る）か
- **generation capacity**（モデル能力天井＝prompt では直らず RAG/モデル構成の問題）か
を切り分ける。

## 🔴 鉄則（[[eval-oracle-asymmetry-pitfall]]）
- judge / embed / 検索 / 対象20件 / 生成モデルは out/34 と**完全固定**。変えるのは `EDGE_SYSTEM_PROMPT` だけ。さもないと改善要因が分離できない。
- judge は 全ref(gold)・temp=0・2軸（`build_2axis_prompt` 不変）。`real relaxed > oracle(92.7%)+1` で停止報告。

## 変更点（`apps/api/eval/out34-calc-benefit-eval.py` のコピーに対して）
新スクリプト `apps/api/eval/out35-calc-benefit-prompt-v2.py` を作る。out34 から以下4点のみ変更:

1. **`EDGE_SYSTEM_PROMPT` を下記 V2 に差し替え**（最終行の overreach 安全制約は保持）。
2. **出力先を新ファイルに**（既存 done_ids スキップ回避のため必須）:
   - `GEN_OUT  = data/rag-mvp-cloud-calc-v2.jsonl`
   - `RESULT_MD = out/35-calc-benefit-prompt-v2.md`
3. **embed cache `rag-corpus-embeddings-qlevel-v2.json` は再利用**（gold 不変＝再embed不要、cache hit で即読込）。
4. **故障分解に bad 3分類を追加**（下記）。

## system prompt V2（確定）
```python
EDGE_SYSTEM_PROMPT = (
    "あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で答えてください。"
    "回答の参考情報には、質問への回答に必要な事実や条件が含まれています。参考情報に単位数・金額・"
    "加算率・人員要件・算定要件・期間などの具体的な数値や条件が記載されている場合は、省略せず回答に含めてください。"
    "利用者の質問が数値・金額・加算率・算定条件を尋ねている場合、それらは回答の核心情報です。"
    "核心情報は要約や一般論に置き換えず、具体的に記載してください。"
    "「施設にご確認ください」「自治体にご確認ください」などの案内は、参考情報に回答が存在しない場合、"
    "または施設・自治体ごとに運用が異なる事項に限って使用してください。"
    "参考情報に記載されている事実や数値を、この案内によって省略してはいけません。"
    "簡潔さは保ちつつ、利用者の判断に必要な数値・条件は漏れなく回答してください。目安は3〜5文です。"
    "医療診断・投薬指示・法令の断定はしないこと。"
)
```
> 設計意図（ユーザー確定）: 「確認済み事実だから全部断定しろ」ではなく **「retrieval に書いてある数値は省略するな」** に寄せる。retrieval ミスや古い情報が混じったときの根拠なき断定を誘発しないため、「絶対に正しい」とは言わない。最終行は overreach 抑止の安全制約として保持（out/34 で overreach=0 を維持するため）。

## bad の3分類（機械判定・排他・out/34 と out/35 の両方に適用）
relaxed bad の各件を `verdict.factual` と `gid_in_top1` で排他分類:

```python
def classify_bad(r):
    v = r.get("verdict") or {}
    if not r.get("gid_in_top1"):
        return "missing"          # Missing in retrieval（参考情報に答えが無い）
    if not v.get("factual"):
        return "misinterpreted"   # Present but misinterpreted（情報はあるが誤解釈/hallucination/outdated）
    return "omitted"              # Present but omitted（情報はあるが答えに織り込めず＝V2の主ターゲット）
```
- 集計対象は `not good_relaxed` の件のみ。
- **out/34 基準値（検算済）**: missing 1（gold-calc-013）/ misinterpreted 1（gold-calc-004 outdated）/ omitted 7（001,002,003,005,012,014,020）。合計 9。

## 成果物（`out/35-calc-benefit-prompt-v2.md`）
1. relaxed / strict good 率 — out/34（55.0% / 40.0%）との対比と改善pt。
2. **bad 3分類の out/34 → out/35 件数推移**（特に **omitted の減少件数**が prompt 成否の主指標）。
3. **件別 diff 表**: `id × out34_relaxed × out35_relaxed × out35_3分類 × reason` — 何が改善/悪化/不変したかを1件ずつ。
   - out/34 の verdict は `data/rag-mvp-cloud-calc.jsonl` から読める（id で join）。
4. 結論:
   - **omitted が大きく減少** → 新律速は generation policy（逃げ・要約し過ぎ）。prompt で解決。本番 rag-mvp.py の `EDGE_SYSTEM` へ反映を Claude が判断。
   - **omitted が残存** → generation capacity 天井。次は RAG 構成（参考情報の渡し方）・モデル選定へ。
   - misinterpreted（factual誤り）の増減も併記（数値強制で hallucination が増えていないか監視）。

## やらないこと
- system prompt 以外の変更（embed / judge / 検索 / 対象20件 / モデルは固定）。
- gold の編集。easy 41件の再評価（calc 20件のみ対象）。
- judge を retrieval 参照採点に戻すこと。

## 完了後（Claude）
out/35 を機械検算（relaxed good 独立再計算・3分類の排他性と合計一致・oracle対称性・factual増減）→ prompt 効果を確定し、本番 `apps/api/eval/rag-mvp.py` の `EDGE_SYSTEM` へ反映するか判断。

関連: [[poc-work-state-2026-06-19]] / [[judge-strictness-usecase-mismatch]] / [[eval-oracle-asymmetry-pitfall]] / [[deepseek-handoff-default]] / out/34 / handoff #17
