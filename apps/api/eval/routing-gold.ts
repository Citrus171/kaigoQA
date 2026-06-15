// ルーティング評価の gold セット（介護ドメイン・held-out）。
//
// ⚠️ ラベルは暫定（ADR 0001 制約4）。最終sign-offは介護実務者のレビュー必須。
//
// == ラベル判定基準（2026-06-16 確定 / 「中間: 事実列挙=edge / 適用=cloud」）==
//   edge  = 制度の事実列挙・概要。個別性なし・算定なし・適用判断なし。
//           例: 認定の流れ、会議の義務、サービス概要/違い、区分での一般的な差。
//   cloud = 適用判断・算定・解釈・個別相談・法令。
//           例:「自分のケースで対象か」「いくらになるか」「すべきか」「要件を満たすか」、
//               加算算定、限度額計算、法令解釈、税要件の当てはめ。
//   ※ positive(注目)=cloud。本来Cloud→edge=FN が最も危険なので層化で厚め。

export type Tier = "edge" | "cloud";

export interface GoldCase {
  query: string;
  expected: Tier;
  category: string;
  note?: string;
}

export const routingGold: GoldCase[] = [
  // --- edge: 挨拶 / 運営FAQ / 一般説明・制度の事実列挙 ---
  { query: "こんにちは", expected: "edge", category: "greeting" },
  { query: "おはようございます", expected: "edge", category: "greeting" },
  { query: "ありがとうございました", expected: "edge", category: "greeting" },
  { query: "営業時間は何時から何時までですか", expected: "edge", category: "faq-hours" },
  { query: "日曜日は営業していますか", expected: "edge", category: "faq-hours" },
  { query: "駐車場はありますか", expected: "edge", category: "faq-facility" },
  { query: "最寄り駅からの行き方を教えてください", expected: "edge", category: "faq-access" },
  { query: "見学はできますか", expected: "edge", category: "faq-visit" },
  { query: "施設にお風呂はありますか", expected: "edge", category: "faq-facility" },
  { query: "送迎はしてもらえますか", expected: "edge", category: "faq-facility" },
  { query: "電話番号を教えてください", expected: "edge", category: "faq-contact" },
  { query: "持ち物は何が必要ですか", expected: "edge", category: "faq-general" },
  { query: "デイサービスとはどんなサービスですか", expected: "edge", category: "general-explain" },
  { query: "ショートステイの一般的な説明をしてください", expected: "edge", category: "general-explain" },
  // 制度の事実列挙（個別性・算定・適用判断なし → edge）。
  { query: "要介護認定はどのように決まりますか", expected: "edge", category: "system-fact", note: "認定の流れの一般説明" },
  { query: "サービス担当者会議の開催義務について教えてください", expected: "edge", category: "system-fact", note: "義務の事実説明" },
  { query: "要支援1から要介護1に変わると使えるサービスはどう変わる？", expected: "edge", category: "system-fact", note: "区分での一般的な差" },

  // --- cloud: 適用判断 / 算定 / 解釈 / 個別相談 / 法令 / 税要件 ---
  // ※ キーワード/法/条 を含まない難問を意図的に多く入れる（rule-baseが取りこぼす想定）。
  { query: "要介護2でデイサービスは何回利用できますか", expected: "cloud", category: "limit-judgment", note: "区分支給限度・個別判断" },
  { query: "負担割合証が2割になる条件を教えてください", expected: "cloud", category: "benefit-ratio", note: "負担割合の条件当てはめ" },
  { query: "特定入所者介護サービス費の対象になりますか", expected: "cloud", category: "policy-apply", note: "対象=適用判断" },
  { query: "区分変更を申請したほうがよいか相談したい", expected: "cloud", category: "case-judgment" },
  { query: "母が要介護3で、在宅と施設どちらがよいか迷っています", expected: "cloud", category: "case-judgment" },
  { query: "ケアプランの見直しをお願いしたいのですが", expected: "cloud", category: "careplan" },
  { query: "入浴介助加算IとIIの違いと算定要件を教えて", expected: "cloud", category: "addition-calc" },
  { query: "処遇改善加算の算定区分を計算してください", expected: "cloud", category: "addition-calc" },
  { query: "支給限度額を超えた分の自己負担はいくらになりますか", expected: "cloud", category: "addition-calc" },
  { query: "介護保険法第8条の解釈を述べよ", expected: "cloud", category: "law-reference", note: "rule-baseでも捕捉できる対照ケース" },
  { query: "高額介護サービス費の上限はどう判定されますか", expected: "cloud", category: "benefit-ratio", note: "上限判定=適用" },
  { query: "同居家族がいる場合の生活援助の算定可否を判断して", expected: "cloud", category: "case-judgment" },
  { query: "看取り介護加算の算定要件を満たすか確認したい", expected: "cloud", category: "addition-calc" },
  { query: "認知症対応型共同生活介護の入居要件を判断してほしい", expected: "cloud", category: "case-judgment" },
  { query: "医療費控除の対象になる介護サービスを教えてください", expected: "cloud", category: "policy-apply", note: "税要件の当てはめ（対象判定）" },
  { query: "限度額管理期間をまたぐ場合の利用回数の考え方は？", expected: "cloud", category: "limit-judgment" },
  { query: "福祉用具貸与で例外給付が認められるケースを判断して", expected: "cloud", category: "case-judgment" },
];
