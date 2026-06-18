// ルーティングデータ（train / gold）の単一の真実 = JSONL + 検証付きローダ（MLOps投資A）。
//
// 旧: train を src/lib/routing-prototypes.ts、gold を eval/routing-gold.ts に TS リテラル直書き。
// 新: データ形状（JSONL）に分離し、diff/追記/レビューしやすく・将来 Python からも読める形に。
//   各行は安定 id / provenance / reviewStatus / borderline のメタを持つ（実務者レビューの土台）。
//   train/gold とも answerSource（回答ソース軸）を持つ。Layer2 品質evalの所見で「施設固有FAQは
//   SLM/LLM単体では正答不可（RAG必須）」と判明したため、edge条件を満たさない facility-data 系を
//   train・gold 両方で cloud へ再ラベルし定義を整合させた（2026-06-16）。再ビルドは build:model。
//
// 検証は scripts/check-data.ts（npm run check:data）= スキーマ・リーク・重複・balance。
// ここではロード時に zod でスキーマ検証する（壊れた行は即 throw）。

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export type Tier = "edge" | "cloud";

const tier = z.enum(["edge", "cloud"]);
// 出自: synthetic=手作業作成 / real-traffic=実トラフィックから収集（ライブ後のデータフライホイール）。
const provenance = z.enum(["synthetic", "real-traffic"]);
// レビュー状態: pending=暫定（要実務者） / approved=sign-off済 / rejected=要修正。
const reviewStatus = z.enum(["pending", "approved", "rejected"]);

// 回答ソース（Layer2 品質evalで判明した「回答可否」の軸。Layer1の複雑度=tierとは直交）。
//   general       = 一般知識のみで回答可（挨拶・制度概要/事実）→ 能力あるSLMなら edge 可。
//   facility-data = 施設固有情報を要求（営業時間/駐車場/電話番号等）→ RAG必須。SLM/LLM単体は不可。
//   reasoning     = 適用判断/算定/解釈/法令 → cloud。
// edge と言えるのは「general かつ低複雑度」のみ（= SLM単体・一般知識・施設固有情報不要・RAG不要）。
const answerSource = z.enum(["general", "facility-data", "reasoning"]);
export type AnswerSource = z.infer<typeof answerSource>;

const baseSchema = z.object({
  id: z.string().min(1),
  query: z.string().min(1),
  category: z.string().min(1),
  provenance,
  reviewStatus,
  // 境界ケース（判断が割れる/要再ラベル）。実務者レビューの優先対象。
  borderline: z.boolean(),
});

export const trainSchema = baseSchema.extend({ label: tier, answerSource });
// 回答のsign-off状態（routingの reviewStatus=振り分けラベルの承認とは別軸）。
//   approved の回答だけを reference 採点の基準に使う（未承認の下書きでノイズ床を汚さない）。
const answerReview = z.enum(["pending", "approved", "rejected"]);

export const goldSchema = baseSchema.extend({
  expected: tier,
  answerSource,
  note: z.string().optional(),
  // 実務者の正解回答（reference採点の土台＝judgeノイズ床を下げる、MLOps投資C-2）。
  //   下書きは一次情報ベースで Claude が起こし、実務者が確認して answerReview を approved にする。
  //   役割分離: answer=実務者レビュー用の可読な模範回答（人間向け）。
  //            referencePoints=judge採点用の「正解要素」配列（機械向け）。
  //   judge には referencePoints を渡し「各要点を満たすか／矛盾しないか」の事実チェックに限定する
  //   （長文 answer をそのまま渡すと類似度判定に陥りノイズ床削減が薄れるため）。referencePoints が
  //   無ければ answer を 1 要素として代替する。数値は制度改定で腐るので要点を数値非依存にし、
  //   数値依存の確認は独立した 1 要点（「※最新の告示で要確認」）に隔離する。
  answer: z.string().min(1).optional(),
  answerReview: answerReview.optional(),
  referencePoints: z.array(z.string().min(1)).optional(),
});

export type TrainExample = z.infer<typeof trainSchema>;
export type GoldCase = z.infer<typeof goldSchema>;

const dataDir = dirname(fileURLToPath(import.meta.url));

function readJsonl(file: string): unknown[] {
  const text = readFileSync(join(dataDir, file), "utf8");
  return text
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.trim() !== "")
    .map(({ line, n }) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${file}:${n} JSON parse 失敗: ${line.slice(0, 60)}`);
      }
    });
}

export function loadTrain(): TrainExample[] {
  return readJsonl("routing-train.jsonl").map((o) => trainSchema.parse(o));
}

// 既定は Dataset B（edge stress / routing-gold.jsonl）。本番分布の Dataset A など
// 別 split を独立評価したい場合は file を渡す（例: "routing-gold-a.jsonl"）。
// 既存呼び出しは引数なし＝従来どおりで後方互換。
export function loadGold(file = "routing-gold.jsonl"): GoldCase[] {
  return readJsonl(file).map((o) => goldSchema.parse(o));
}

/**
 * reference 採点に渡す「正解要点」を返す（承認ゲート + 素材選択を一元化）。
 *   - answerReview!=="approved" → undefined（未承認は採点に混ぜない＝ノイズ床を汚さない）。
 *   - referencePoints があればそれを、無ければ answer を 1 要素として返す。
 *   - どちらも無ければ undefined（judge は従来の reference なし採点にフォールバック）。
 */
export function referencePointsOf(g: GoldCase): string[] | undefined {
  if (g.answerReview !== "approved") return undefined;
  if (g.referencePoints?.length) return g.referencePoints;
  if (g.answer) return [g.answer];
  return undefined;
}
