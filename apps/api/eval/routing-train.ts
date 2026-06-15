// セントロイド分類器の学習用プロトタイプ（ADR 0001 Step2）。
//
// ⚠️ 評価リーク防止: routing-gold.ts(評価=held-out) とは別の文言にすること。
//    同じ文を学習にも評価にも使うと指標が水増しされる。
// ⚠️ ラベルは暫定・要実務者レビュー（gold と同じ注意）。
//
// 各クラスの「典型例」。これらの埋め込み平均=セントロイドを作り、
// 新規クエリを最も近いセントロイドへ割り当てる。

import type { Tier } from "./routing-gold";

export interface TrainCase {
  query: string;
  label: Tier;
  category: string;
}

export const routingTrain: TrainCase[] = [
  // --- edge: 挨拶 / FAQ / 営業・アクセス / 一般説明 ---
  { query: "はじめまして、よろしくお願いします", label: "edge", category: "greeting" },
  { query: "こんばんは", label: "edge", category: "greeting" },
  { query: "お世話になっております", label: "edge", category: "greeting" },
  { query: "受付は何時までですか", label: "edge", category: "faq-hours" },
  { query: "祝日はやっていますか", label: "edge", category: "faq-hours" },
  { query: "バスで行くことはできますか", label: "edge", category: "faq-access" },
  { query: "車椅子でも入れますか", label: "edge", category: "faq-facility" },
  { query: "食事は出ますか", label: "edge", category: "faq-facility" },
  { query: "体験利用はありますか", label: "edge", category: "faq-visit" },
  { query: "デイサービスとデイケアの違いをざっくり教えて", label: "edge", category: "general-explain" },
  { query: "ショートステイは何泊までですか（一般的に）", label: "edge", category: "general-explain" },
  { query: "問い合わせ窓口はどこですか", label: "edge", category: "faq-contact" },

  // --- cloud: 制度解釈 / 加算計算 / ケアプラン / 法令参照 / 個別ケース判断 ---
  { query: "要介護1だと月にどれくらいサービスを使えますか", label: "cloud", category: "limit-judgment" },
  { query: "利用者負担が3割になるのはどういう場合ですか", label: "cloud", category: "benefit-ratio" },
  { query: "補足給付の対象かどうか判断してほしい", label: "cloud", category: "policy-interpret" },
  { query: "要介護認定の有効期間はどう決まりますか", label: "cloud", category: "policy-interpret" },
  { query: "区分変更すべきか状況を見て相談に乗ってほしい", label: "cloud", category: "case-judgment" },
  { query: "父の状態が変わったのでケアプランを作り直したい", label: "cloud", category: "careplan" },
  { query: "個別機能訓練加算の算定要件を満たしているか教えて", label: "cloud", category: "addition-calc" },
  { query: "限度額を超えたときの自己負担額を計算してほしい", label: "cloud", category: "addition-calc" },
  { query: "高額介護サービス費の払い戻しはどう判定されますか", label: "cloud", category: "benefit-ratio" },
  { query: "生活援助の回数制限の取り扱いを判断してほしい", label: "cloud", category: "case-judgment" },
  { query: "夜間対応型訪問介護の利用要件を満たすか確認したい", label: "cloud", category: "case-judgment" },
  { query: "要支援と要介護でケアマネの担当はどう変わりますか", label: "cloud", category: "policy-interpret" },
];
