// ルーティング評価の gold セット（介護ドメイン）。
//
// ⚠️ ラベルは暫定（ADR 0001 の制約4）。本番化前に介護実務者のレビュー必須。
//    我々の推測ラベルのまま分類器を学習/評価すると、同じバイアスで指標も汚染される。
//
// 設計（ADR 0001）:
// - positive(注目)クラス = "cloud"。本来Cloudをedgeへ流す = False Negative が最も危険。
// - 危険な少数派=cloud必須を層化で厚めに入れる（1件で指標が振れるため）。
// - tier はあくまで「edgeで完結してよいか/cloud必須か」の難易度推定であって出力自信ではない。

export type Tier = "edge" | "cloud";

export interface GoldCase {
  query: string;
  expected: Tier;
  // ラベル根拠のカテゴリ（層化・誤分類分析用）。
  category: string;
  note?: string;
}

export const routingGold: GoldCase[] = [
  // --- edge 寄り: 挨拶 / FAQ / 営業・アクセス / 一般説明 ---
  { query: "こんにちは", expected: "edge", category: "greeting" },
  { query: "おはようございます", expected: "edge", category: "greeting" },
  { query: "ありがとうございました", expected: "edge", category: "greeting" },
  { query: "営業時間は何時から何時までですか", expected: "edge", category: "faq-hours" },
  { query: "日曜日は営業していますか", expected: "edge", category: "faq-hours" },
  { query: "駐車場はありますか", expected: "edge", category: "faq-facility" },
  { query: "最寄り駅からの行き方を教えてください", expected: "edge", category: "faq-access" },
  { query: "見学はできますか", expected: "edge", category: "faq-visit" },
  { query: "デイサービスとはどんなサービスですか", expected: "edge", category: "general-explain" },
  { query: "ショートステイの一般的な説明をしてください", expected: "edge", category: "general-explain" },
  { query: "施設にお風呂はありますか", expected: "edge", category: "faq-facility" },
  { query: "送迎はしてもらえますか", expected: "edge", category: "faq-facility" },
  { query: "電話番号を教えてください", expected: "edge", category: "faq-contact" },
  { query: "持ち物は何が必要ですか", expected: "edge", category: "faq-general" },

  // --- cloud 寄り: 制度解釈 / 加算計算 / ケアプラン / 法令参照 / 個別ケース判断 ---
  // ※ キーワード/法/条 を含まない難問を意図的に多く入れる（rule-baseが取りこぼす想定）。
  { query: "要介護2でデイサービスは何回利用できますか", expected: "cloud", category: "limit-judgment", note: "区分支給限度・個別判断" },
  { query: "負担割合証が2割になる条件を教えてください", expected: "cloud", category: "benefit-ratio" },
  { query: "特定入所者介護サービス費の対象になりますか", expected: "cloud", category: "policy-interpret" },
  { query: "要介護認定はどのように決まりますか", expected: "cloud", category: "policy-interpret" },
  { query: "区分変更を申請したほうがよいか相談したい", expected: "cloud", category: "case-judgment" },
  { query: "母が要介護3で、在宅と施設どちらがよいか迷っています", expected: "cloud", category: "case-judgment" },
  { query: "ケアプランの見直しをお願いしたいのですが", expected: "cloud", category: "careplan" },
  { query: "入浴介助加算IとIIの違いと算定要件を教えて", expected: "cloud", category: "addition-calc" },
  { query: "処遇改善加算の算定区分を計算してください", expected: "cloud", category: "addition-calc" },
  { query: "支給限度額を超えた分の自己負担はいくらになりますか", expected: "cloud", category: "addition-calc" },
  { query: "サービス担当者会議の開催義務について教えてください", expected: "cloud", category: "policy-interpret" },
  { query: "介護保険法第8条の解釈を述べよ", expected: "cloud", category: "law-reference", note: "rule-baseでも捕捉できる対照ケース" },
  { query: "高額介護サービス費の上限はどう判定されますか", expected: "cloud", category: "benefit-ratio" },
  { query: "同居家族がいる場合の生活援助の算定可否を判断して", expected: "cloud", category: "case-judgment" },
  { query: "看取り介護加算の算定要件を満たすか確認したい", expected: "cloud", category: "addition-calc" },
  { query: "要支援1から要介護1に変わると使えるサービスはどう変わる？", expected: "cloud", category: "policy-interpret" },
  { query: "認知症対応型共同生活介護の入居要件を判断してほしい", expected: "cloud", category: "case-judgment" },
  { query: "医療費控除の対象になる介護サービスを教えてください", expected: "cloud", category: "policy-interpret", note: "税が絡む" },
  { query: "限度額管理期間をまたぐ場合の利用回数の考え方は？", expected: "cloud", category: "limit-judgment" },
  { query: "福祉用具貸与で例外給付が認められるケースを判断して", expected: "cloud", category: "case-judgment" },
];
