// 独立 judge による再採点（Phase 3）。eval:e2e が保存した JSONL（回答本文入り）を読み、
// 生成系と別系統の judge（既定=OpenRouter経由 GPT-4o）で edge/cloud 回答を採点し直す。
//
// 目的: eval:e2e の cloud 採点は cloud と同一 deepseek＝自己採点でバイアスがある。生成を1回確定し
//   judge だけ差し替えて再採点することで「latency-55%を維持したまま品質維持できているか」を
//   自己採点バイアス無しで客観評価する（生成1回・judge何度でも＝研究資産）。
//
// 出力:
//   - ポリシー別 good率（独立judge採点ベース。eval:e2e の自己採点版と比較できる）
//   - 旧judge(deepseek)との一致度（= 自己採点が品質を過大評価していた度合いの定量化）
//   - 再採点 verdict を全件 JSONL に保存（多数決judge追加や再集計の素地）
//
// 【Phase E】flip率モード（--repeat K, K≥2）: judgeノイズ床の定量化（投資C-2の効果検証）。
//   生成回答を固定したまま、同一回答を judge に K 回かけ、参照あり(referencePoints)/なしの両方で
//   isGoodAnswer の判定が揺れる割合（flip率=K回の判定が不一致な項目の割合）を比較する。
//   参照採点でflip率が下がれば「参照採点はノイズ床を下げる」が実証される（[[stage2-eval-design]]）。
//   対象は承認済み参照を持つ項目のみ（参照あり/なしの paired A/B）。
//
// 実行: OPENROUTER_API_KEY=... npm run eval:rejudge -w @hybrid/api -- <input.jsonl>
//   flip率: ... -- <input.jsonl> --repeat 5   （または REJUDGE_REPEAT=5）
//   入力省略時は eval/data/e2e-ollama-gemma3-4b.jsonl を採点。
//   judge切替: JUDGE_MODEL=anthropic/claude-opus-4 等（env、OpenAI直なら JUDGE_BASE_URL も）。

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/lib/load-env";
loadEnv();
import { OpenRouterProvider } from "../src/lib/inference";
import { judgeAnswer, isGoodAnswer, type JudgeVerdict } from "./judge";
import { loadGold, referencePointsOf, type Tier } from "./data/load";

// gold を id→正規化query で引けるようにする（参照採点で承認済みの正解要点を渡すため）。
// 入力 e2e JSONL の id は gold.id と同形（"gold-NN"）なので id 一致が基本。万一 id が
// 揃わない入力に備え query 正規化マッチへフォールバックする（安全側＝無ければ参照なし採点）。
// 採点基準は referencePointsOf（承認ゲート + referencePoints||answer 選択）に一元化。
const normQuery = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
function buildReferenceLookup() {
  const byId = new Map<string, string[]>();
  const byQuery = new Map<string, string[]>();
  for (const g of loadGold()) {
    const points = referencePointsOf(g);
    if (points) {
      byId.set(g.id, points);
      byQuery.set(normQuery(g.query), points);
    }
  }
  return (id: string, query: string): string[] | undefined =>
    byId.get(id) ?? byQuery.get(normQuery(query));
}

// eval:e2e が保存する 1 回答分のレコード（必要フィールドのみ。verdict は旧=deepseek採点）。
interface GenRec {
  answer: string;
  genFailed: boolean;
  skipped?: boolean;
  verdict: JudgeVerdict | null;
  model: string;
  rejudge?: JudgeVerdict | null; // 本スクリプトが付与する独立judge採点。
}
interface CaseRec {
  id: string;
  query: string;
  expected: Tier;
  routing: { predictedTier: Tier };
  edge: GenRec;
  cloud: GenRec;
}

type Policy = "always-edge" | "always-cloud" | "routed";

// eval:e2e と同一の選択ロジック（ポリシーが実際に使う側の回答を返す）。
const genOf = (rec: CaseRec, policy: Policy): GenRec =>
  policy === "always-edge"
    ? rec.edge
    : policy === "always-cloud"
      ? rec.cloud
      : rec.routing.predictedTier === "edge"
        ? rec.edge
        : rec.cloud;

// 採点可能 = スキップでも生成失敗でも空でもない（= 評価対象の本文がある）。
const judgeable = (g: GenRec) => !g.skipped && !g.genFailed && g.answer.trim() !== "";

const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);

// 位置引数(入力パス) と --repeat K / REJUDGE_REPEAT を分離して取得。
function parseArgs(): { inPath?: string; repeat: number } {
  const args = process.argv.slice(2);
  let inPath: string | undefined;
  let repeat = Number(process.env.REJUDGE_REPEAT ?? 1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--repeat") repeat = Number(args[++i]);
    else if (a.startsWith("--repeat=")) repeat = Number(a.slice("--repeat=".length));
    else if (!a.startsWith("--") && !inPath) inPath = a;
  }
  if (!Number.isFinite(repeat) || repeat < 1) repeat = 1;
  return { inPath, repeat };
}

// 同一回答を judge に K 回かけ、各回の verdict と isGoodAnswer を返す（採点不能は安全側=bad）。
async function judgeK(
  judge: OpenRouterProvider,
  query: string,
  answer: string,
  reference: string[] | undefined,
  k: number,
  onCall: () => void,
): Promise<{ verdicts: JudgeVerdict[]; goods: boolean[] }> {
  const verdicts: JudgeVerdict[] = [];
  for (let i = 0; i < k; i++) {
    let v: JudgeVerdict;
    try {
      v = await judgeAnswer(judge, query, answer, reference);
    } catch {
      v = { factual: false, overreach: false, sufficient: false, category: "refusal", reason: "judge採点不能" };
    }
    verdicts.push(v);
    onCall();
  }
  return { verdicts, goods: verdicts.map(isGoodAnswer) };
}

// K回の good/bad 判定が不一致なら flip（判定が揺れた＝ノイズ）。全一致なら安定。
const flipped = (goods: boolean[]) => goods.some((g) => g) && goods.some((g) => !g);
const majorityGood = (goods: boolean[]) => goods.filter((g) => g).length * 2 > goods.length;

// flip率モード（Phase E）。参照あり/なしで同一回答を K 回採点し flip率を比較する。
interface FlipItem {
  id: string;
  side: "edge" | "cloud";
  query: string;
  off: { verdicts: JudgeVerdict[]; goods: boolean[]; flipped: boolean; majorityGood: boolean };
  on: { verdicts: JudgeVerdict[]; goods: boolean[]; flipped: boolean; majorityGood: boolean };
}

async function runFlipMode(
  records: CaseRec[],
  judge: OpenRouterProvider,
  refOf: (id: string, query: string) => string[] | undefined,
  repeat: number,
  here: string,
  inPath: string,
) {
  // 対象 = 承認済み参照を持つ採点可能な (record, side)。参照あり/なしの paired A/B にする。
  const targets: { rec: CaseRec; side: "edge" | "cloud"; reference: string[] }[] = [];
  for (const rec of records) {
    const reference = refOf(rec.id, rec.query);
    if (!reference) continue;
    for (const side of ["edge", "cloud"] as const) {
      if (judgeable(rec[side])) targets.push({ rec, side, reference });
    }
  }

  console.log("=== flip率モード（Phase E: 参照採点のノイズ床削減を実証）===");
  console.log(`入力: ${inPath}（${records.length}件）`);
  console.log(`judge: ${judge.name} / 温度=${judge.temperature} / 反復 K=${repeat} / 対象=参照あり項目 ${targets.length}件`);
  if (judge.temperature === 0) {
    console.log("⚠ 温度0では判定が決定論的でflipが起きません。JUDGE_TEMPERATURE=0.7 等を設定してください。");
  }
  console.log("");

  if (targets.length === 0) {
    console.log("⚠ 参照あり(answerReview=approved)の採点可能な項目が入力に存在しません。");
    console.log("  flip率の paired 比較には、承認済み cloud 項目を含む全件 E2E JSONL が必要です。");
    console.log("  （現状の cloudonly サンプルには edge2件のみで参照対象が無い。GPU full E2E の出力を入力に指定してください）");
    return;
  }

  const totalCalls = targets.length * repeat * 2; // 参照なし K + 参照あり K
  let done = 0;
  const tick = () => process.stdout.write(`\r  judge呼び出し ${++done}/${totalCalls}`);

  const items: FlipItem[] = [];
  for (const { rec, side, reference } of targets) {
    const g = rec[side];
    const off = await judgeK(judge, rec.query, g.answer, undefined, repeat, tick); // 参照なし
    const on = await judgeK(judge, rec.query, g.answer, reference, repeat, tick); // 参照あり
    items.push({
      id: rec.id,
      side,
      query: rec.query,
      off: { ...off, flipped: flipped(off.goods), majorityGood: majorityGood(off.goods) },
      on: { ...on, flipped: flipped(on.goods), majorityGood: majorityGood(on.goods) },
    });
  }
  console.log("\n");

  const offFlip = items.filter((it) => it.off.flipped).length;
  const onFlip = items.filter((it) => it.on.flipped).length;
  const n = items.length;

  console.log("=== flip率（K回の good/bad 判定が揺れた項目の割合。低いほどノイズ床が低い）===");
  console.log(`  参照なし採点: flip率 ${pct(offFlip, n)} (${offFlip}/${n})`);
  console.log(`  参照あり採点: flip率 ${pct(onFlip, n)} (${onFlip}/${n})`);
  const delta = offFlip - onFlip;
  console.log(
    `  → 参照採点による flip 削減: ${delta}件 (${pct(Math.abs(delta), n)} ${delta >= 0 ? "減" : "増"})`,
  );

  // 多数決 good率の差（参照ありで甘く/辛くなっていないかの副次確認）。
  const offGood = items.filter((it) => it.off.majorityGood).length;
  const onGood = items.filter((it) => it.on.majorityGood).length;
  console.log(`\n  多数決good率: 参照なし ${pct(offGood, n)} / 参照あり ${pct(onGood, n)}`);

  // flip した項目を列挙（どちらのモードで揺れたか）。
  const flippedItems = items.filter((it) => it.off.flipped || it.on.flipped);
  if (flippedItems.length) {
    console.log("\n  flip 項目（off/on でK回の判定が揺れた）:");
    for (const it of flippedItems) {
      const f = (m: FlipItem["off"]) => `${m.goods.filter((g) => g).length}/${m.goods.length}good${m.flipped ? "⚡" : ""}`;
      console.log(`    [${it.id}/${it.side}] off:${f(it.off)} on:${f(it.on)}  ${it.query}`);
    }
  }

  // 保存（K回分の verdict 全件。再集計・多数決judge の素地）。
  const judgeSlug = judge.name.replace(/[^a-z0-9]+/gi, "-");
  const outPath = join(here, "data", `flip-${judgeSlug}-k${repeat}-${basename(inPath)}`);
  writeFileSync(outPath, items.map((it) => JSON.stringify(it)).join("\n") + "\n");
  console.log(`\n保存: ${outPath}（flip生データ ${items.length}項目 × off/on × K=${repeat}）`);
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const { inPath: argPath, repeat } = parseArgs();
  const inPath = argPath ?? join(here, "data", "e2e-ollama-gemma3-4b.jsonl");
  const lines = readFileSync(inPath, "utf8").split("\n").filter((l) => l.trim() !== "");
  const records = lines.map((l) => JSON.parse(l) as CaseRec);

  // flip率モードは判定の揺れを測るので非0温度が必須。未設定なら 0.7 を既定にする
  // （JUDGE_TEMPERATURE を明示すれば尊重）。OpenRouterProvider 構築前に設定する。
  if (repeat >= 2 && process.env.JUDGE_TEMPERATURE == null) {
    process.env.JUDGE_TEMPERATURE = "0.7";
  }

  const judge = new OpenRouterProvider();
  const refOf = buildReferenceLookup();

  // --repeat K（K≥2）が指定されたら flip率モードへ分岐（既存の単発再採点はそのまま）。
  if (repeat >= 2) {
    await runFlipMode(records, judge, refOf, repeat, here, inPath);
    return;
  }

  const refCount = records.filter((r) => refOf(r.id, r.query)).length;
  console.log("=== 独立judge 再採点 ===");
  console.log(`入力: ${inPath}（${records.length}件 / うち参照採点=${refCount}件）`);
  console.log(`judge: ${judge.name}（生成=deepseek系と別系統＝自己採点バイアス無し）\n`);

  // edge/cloud の採点対象を全件 judge にかける（sequential＝API負荷を抑制・進捗を可視化）。
  let done = 0;
  const total = records.reduce((n, r) => n + (judgeable(r.edge) ? 1 : 0) + (judgeable(r.cloud) ? 1 : 0), 0);
  for (const rec of records) {
    for (const side of ["edge", "cloud"] as const) {
      const g = rec[side];
      if (!judgeable(g)) {
        g.rejudge = null;
        continue;
      }
      try {
        // 承認済み参照回答があれば reference 採点（生成回答を参照に照らして事実チェック＝ノイズ床↓）。
        g.rejudge = await judgeAnswer(judge, rec.query, g.answer, refOf(rec.id, rec.query));
      } catch (e) {
        // 採点不能は安全側（factual/sufficient=false）で記録し集計から欠落させない。
        g.rejudge = { factual: false, overreach: false, sufficient: false, category: "refusal", reason: "judge採点不能" };
        console.error(`\n  ⚠ ${rec.id}/${side} 採点失敗: ${e instanceof Error ? e.message : e}`);
      }
      process.stdout.write(`\r  採点 ${++done}/${total}`);
    }
  }
  console.log("\n");

  // --- ポリシー別 good率（独立judge / 旧deepseek自己採点 を並記）---
  const policies: Policy[] = ["always-edge", "always-cloud", "routed"];
  console.log("=== ポリシー別 good率（独立judge vs 旧deepseek自己採点）===");
  console.log("  policy        | 独立judge good率 | 旧deepseek good率 | n");
  const goodRate = (p: Policy, pick: (g: GenRec) => JudgeVerdict | null) => {
    let good = 0, n = 0;
    for (const rec of records) {
      const g = genOf(rec, p);
      if (!judgeable(g)) continue;
      const v = pick(g);
      if (!v) continue;
      n++;
      if (isGoodAnswer(v)) good++;
    }
    return { good, n };
  };
  for (const p of policies) {
    const ind = goodRate(p, (g) => g.rejudge ?? null);
    const old = goodRate(p, (g) => g.verdict);
    if (ind.n === 0) {
      console.log(`  ${p.padEnd(13)} | ${"（対象なし）".padStart(14)} | edge未測定`);
      continue;
    }
    console.log(
      `  ${p.padEnd(13)} | ${pct(ind.good, ind.n).padStart(14)} | ${pct(old.good, old.n).padStart(15)} | ${ind.n}`,
    );
  }

  // --- judge間 一致度（自己採点バイアスの定量化）---
  // 旧verdict と 新rejudge が両方ある回答について isGoodAnswer の一致を見る。
  let agree = 0, both = 0, oldGoodNewBad = 0, oldBadNewGood = 0;
  for (const rec of records) {
    for (const side of ["edge", "cloud"] as const) {
      const g = rec[side];
      if (!g.verdict || !g.rejudge) continue;
      both++;
      const o = isGoodAnswer(g.verdict), n = isGoodAnswer(g.rejudge);
      if (o === n) agree++;
      else if (o && !n) oldGoodNewBad++;
      else oldBadNewGood++;
    }
  }
  console.log("\n=== judge間 一致度（旧deepseek自己採点 ↔ 独立judge）===");
  console.log(`  good/bad 一致: ${pct(agree, both)} (${agree}/${both})`);
  console.log(`  旧good→新bad（自己採点の過大評価）: ${oldGoodNewBad}件`);
  console.log(`  旧bad→新good（独立judgeの方が甘い）: ${oldBadNewGood}件`);

  // --- 保存（再採点 verdict 付き。多数決judge追加や再集計の素地）---
  const judgeSlug = judge.name.replace(/[^a-z0-9]+/gi, "-");
  const outPath = join(here, "data", `rejudge-${judgeSlug}-${basename(inPath)}`);
  writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\n保存: ${outPath}（再採点verdict付き ${records.length}件）`);
}

main().catch((e) => {
  console.error("\neval:rejudge 失敗:", e instanceof Error ? e.message : e);
  console.error("（要 OPENROUTER_API_KEY。judge切替は JUDGE_MODEL / JUDGE_BASE_URL）");
  process.exit(1);
});
