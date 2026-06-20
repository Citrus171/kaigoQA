// ルーティングデータの検証（MLOps投資A = CI ゲート）。Ollama/DB 不要・即実行可。
//
// 検証項目:
//   1. スキーマ      … loadTrain/loadGold が zod で検証（壊れた行は throw）。
//   2. id 一意       … train+gold(+A) 全体で id 重複なし。
//   3. 重複          … 各セット内で同一文言（正規化後）の重複なし。
//   4. リーク        … train⇄gold / train⇄A / gold⇄A に同一文言が現れない
//                      （held-out の独立性。特に train⇄A は分類器プロトタイプ汚染＝致命）。
//   5. クラスバランス  … cloud/edge の偏りが極端でないこと（少数クラス ≥ 25%）。
//   6. 参照整合       … approved なのに採点根拠（referencePoints/answer）欠落＝違反。
// ハード違反（2-4・6・スキーマ）で exit 1。balance は警告。
//
// Dataset A（本番分布・routing-gold-a.jsonl）が存在する場合のみ A も同基準で検証する
// （未生成なら従来どおり train+B のみ＝完全後方互換）。
//
// 実行: npm run check:data -w @hybrid/api （`check` に組み込み済み）。

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadTrain, loadGold, type GoldCase } from "../eval/data/load";

const norm = (s: string) =>
  s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

const errors: string[] = [];
const warns: string[] = [];

const train = loadTrain();
const gold = loadGold();

// Dataset A は存在する時だけ読む（未生成＝空＝従来挙動）。
const dataDir = fileURLToPath(new URL("../eval/data/", import.meta.url));
const A_FILE = "routing-gold-a.jsonl";
const goldA: GoldCase[] = existsSync(join(dataDir, A_FILE)) ? loadGold(A_FILE) : [];

console.log(
  `=== check:data （train=${train.length} / gold=${gold.length}${goldA.length ? ` / goldA=${goldA.length}` : " / goldA=なし"}）===`,
);

// 全 gold ライク集合（B + あればA）。reference 整合チェックで共用。
const allGold = [...gold, ...goldA];

// 2. id 一意（train + gold + A 全体）。
const ids = [...train.map((t) => t.id), ...allGold.map((g) => g.id)];
const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupIds.length) errors.push(`id 重複: ${[...new Set(dupIds)].join(", ")}`);

// 3. セット内の文言重複。
const sets = [
  ["train", train.map((t) => t.query)],
  ["gold", gold.map((g) => g.query)],
  ...(goldA.length ? [["goldA", goldA.map((g) => g.query)] as const] : []),
] as const;
for (const [name, queries] of sets) {
  const seen = new Map<string, string>();
  for (const q of queries) {
    const k = norm(q);
    if (seen.has(k)) errors.push(`${name} 重複文言: 「${q}」`);
    else seen.set(k, q);
  }
}

// 4. リーク（同一文言の越境）。
const trainKeys = new Set(train.map((t) => norm(t.query)));
const goldKeys = new Set(gold.map((g) => norm(g.query)));
for (const g of gold) {
  if (trainKeys.has(norm(g.query))) {
    errors.push(`リーク（train⇄gold 同一文言）: 「${g.query}」(${g.id})`);
  }
}
for (const a of goldA) {
  // train⇄A: 分類器プロトタイプに混入すると held-out 評価が無意味化＝最重要。
  if (trainKeys.has(norm(a.query))) {
    errors.push(`リーク（train⇄A 同一文言）: 「${a.query}」(${a.id})`);
  }
  // gold(B)⇄A: 評価セット間の重複（独立性のため排除）。
  if (goldKeys.has(norm(a.query))) {
    errors.push(`リーク（gold⇄A 同一文言）: 「${a.query}」(${a.id})`);
  }
}

// 5. クラスバランス（少数クラス比率）。
function balance(name: string, labels: string[], borderlineCount: number) {
  const cloud = labels.filter((l) => l === "cloud").length;
  const edge = labels.length - cloud;
  const minRatio = labels.length ? Math.min(cloud, edge) / labels.length : 0;
  console.log(
    `  ${name}: cloud=${cloud} edge=${edge} 少数クラス=${(minRatio * 100).toFixed(0)}% borderline=${borderlineCount}`,
  );
  if (labels.length && minRatio < 0.25) {
    warns.push(`${name} のクラスバランスが偏り気味（少数クラス ${(minRatio * 100).toFixed(0)}% < 25%）`);
  }
}
balance("train", train.map((t) => t.label), train.filter((t) => t.borderline).length);
balance("gold", gold.map((g) => g.expected), gold.filter((g) => g.borderline).length);
if (goldA.length) {
  balance("goldA", goldA.map((g) => g.expected), goldA.filter((g) => g.borderline).length);
}

// 6. 参照回答（reference gold）の整合性。train+B+A 共通基準。
//    - approved なのに answer/referencePoints 欠落 = ハード違反（採点が壊れる）。
//    - 参照素材有りなのに answerReview 欠落 = 状態未設定（pending を明示すべき）→ 違反。
const withAnswer = allGold.filter((g) => g.answer);
const withPoints = allGold.filter((g) => g.referencePoints?.length);
const approved = allGold.filter((g) => g.answerReview === "approved");
const draftPending = allGold.filter((g) => g.answer && g.answerReview === "pending");
for (const g of allGold) {
  if (g.answerReview === "approved" && !g.referencePoints?.length && !g.answer) {
    errors.push(`reference: ${g.id} は answerReview=approved だが referencePoints も answer も空`);
  }
  if ((g.answer || g.referencePoints?.length) && !g.answerReview) {
    errors.push(`reference: ${g.id} は参照素材有りだが answerReview 未設定（pending を明示）`);
  }
}
console.log(
  `  reference: answer付き=${withAnswer.length} / referencePoints付き=${withPoints.length} (approved=${approved.length} / 下書きpending=${draftPending.length})`,
);

for (const w of warns) console.log(`  ⚠️ ${w}`);
if (errors.length) {
  console.error(`\n❌ ${errors.length} 件の違反:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("\n✅ データ検証 OK（スキーマ・id一意・重複なし・リークなし）");
