// ルーティングデータの検証（MLOps投資A = CI ゲート）。Ollama/DB 不要・即実行可。
//
// 検証項目:
//   1. スキーマ      … loadTrain/loadGold が zod で検証（壊れた行は throw）。
//   2. id 一意       … train+gold 全体で id 重複なし。
//   3. 重複          … 各セット内で同一文言（正規化後）の重複なし。
//   4. train/gold リーク … 両セットに同一文言が現れない（held-out の独立性を機械保証）。
//   5. クラスバランス  … cloud/edge の偏りが極端でないこと（少数クラス ≥ 25%）。
// ハード違反（2-4・スキーマ）で exit 1。balance は警告。
//
// 実行: npm run check:data -w @hybrid/api （`check` に組み込み済み）。

import { loadTrain, loadGold } from "../eval/data/load";

const norm = (s: string) =>
  s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

const errors: string[] = [];
const warns: string[] = [];

const train = loadTrain();
const gold = loadGold();
console.log(`=== check:data （train=${train.length} / gold=${gold.length}）===`);

// 2. id 一意（全体）。
const ids = [...train.map((t) => t.id), ...gold.map((g) => g.id)];
const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupIds.length) errors.push(`id 重複: ${[...new Set(dupIds)].join(", ")}`);

// 3. セット内の文言重複。
for (const [name, queries] of [
  ["train", train.map((t) => t.query)],
  ["gold", gold.map((g) => g.query)],
] as const) {
  const seen = new Map<string, string>();
  for (const q of queries) {
    const k = norm(q);
    if (seen.has(k)) errors.push(`${name} 重複文言: 「${q}」`);
    else seen.set(k, q);
  }
}

// 4. train/gold リーク（同一文言の越境）。
const trainKeys = new Set(train.map((t) => norm(t.query)));
for (const g of gold) {
  if (trainKeys.has(norm(g.query))) {
    errors.push(`リーク（train⇄gold 同一文言）: 「${g.query}」(${g.id})`);
  }
}

// 5. クラスバランス（少数クラス比率）。
function balance(name: string, labels: string[]) {
  const cloud = labels.filter((l) => l === "cloud").length;
  const edge = labels.length - cloud;
  const minRatio = Math.min(cloud, edge) / labels.length;
  const border =
    name === "train"
      ? train.filter((t) => t.borderline).length
      : gold.filter((g) => g.borderline).length;
  console.log(
    `  ${name}: cloud=${cloud} edge=${edge} 少数クラス=${(minRatio * 100).toFixed(0)}% borderline=${border}`,
  );
  if (minRatio < 0.25) {
    warns.push(`${name} のクラスバランスが偏り気味（少数クラス ${(minRatio * 100).toFixed(0)}% < 25%）`);
  }
}
balance("train", train.map((t) => t.label));
balance("gold", gold.map((g) => g.expected));

// 6. 参照回答（reference gold）の整合性。
//    - approved なのに answer 欠落 = ハード違反（採点が壊れる）。
//    - answer 有りなのに answerReview 欠落 = 状態未設定（pending 扱いの明示漏れ）→ 違反。
//    - 進捗の可視化: approved / pending(下書き) 件数を出す。
const withAnswer = gold.filter((g) => g.answer);
const withPoints = gold.filter((g) => g.referencePoints?.length);
const approved = gold.filter((g) => g.answerReview === "approved");
const draftPending = gold.filter((g) => g.answer && g.answerReview === "pending");
for (const g of gold) {
  // approved なら採点可能な根拠（referencePoints か answer）が必須＝無いと参照採点が空振り。
  if (g.answerReview === "approved" && !g.referencePoints?.length && !g.answer) {
    errors.push(`reference: ${g.id} は answerReview=approved だが referencePoints も answer も空`);
  }
  // 参照素材（answer / referencePoints）が有るのに状態未設定 = pending を明示すべき。
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
