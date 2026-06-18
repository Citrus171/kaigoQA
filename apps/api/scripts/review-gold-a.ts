// Dataset A 対話レビューCLI（人手承認を最短化する）。
//
// 思想（share/2026-06-18-01 承認チェックリスト / 04 提案より）:
//   - 全120件を平等に見ない。高リスクの旗（edge / borderline / ★5）だけ順送りでキー操作。
//   - 2パス分割: --labels(既定)=expected承認で閾値パイプを先に解放 / --refs=referencePoints承認(GPU後)。
//   - 1操作ごとに即書き戻し＝中断・再開可能（reviewStatus/answerReview の approved は次回スキップ）。
//
// 入出力:
//   入力 初回: apps/api/eval/out/14-dataset-a-queries.jsonl（無ければ）→ data/routing-gold-a.jsonl を生成
//   以降    : apps/api/eval/data/routing-gold-a.jsonl（ここを編集・再開）
// 実行: npm run review:gold-a -w @hybrid/api -- [--refs] [--all]
//   終了後に `npm run check:data -w @hybrid/api` で機械検証すること。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

type Tier = "edge" | "cloud";
interface Row {
  id: string;
  query: string;
  expected: Tier;
  category: string;
  answerSource: string;
  borderline: boolean;
  reviewStatus: string;
  answerReview?: string;
  note?: string;
  answer?: string;
  referencePoints?: string[];
  [k: string]: unknown;
}

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "../eval/data");
const outDir = join(dirname(fileURLToPath(import.meta.url)), "../eval/out");
const SRC = join(outDir, "14-dataset-a-queries.jsonl");
const DST = join(dataDir, "routing-gold-a.jsonl");

const args = process.argv.slice(2);
const refsMode = args.includes("--refs");
const showAll = args.includes("--all");
const dry = args.includes("--dry"); // 対象件数だけ表示して終了（TTY不要・検証用）

const starCount = (r: Row) =>
  (r.referencePoints ?? []).filter((p) => p.startsWith("★")).length;

function load(): Row[] {
  if (!existsSync(DST)) {
    if (!existsSync(SRC)) {
      console.error(`入力が見つかりません: ${SRC}`);
      process.exit(1);
    }
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(DST, readFileSync(SRC, "utf8"));
    console.log(`初期化: ${SRC} → ${DST}`);
  }
  return readFileSync(DST, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row);
}

const rows = load();
const byId = (a: Row, b: Row) => a.id.localeCompare(b.id);
const persist = () =>
  writeFileSync(
    DST,
    [...rows].sort(byId).map((r) => JSON.stringify(r)).join("\n") + "\n",
  );

// レビュー対象（旗）の抽出。
function worklist(): Row[] {
  if (refsMode) {
    // 未承認かつ referencePoints を持つ項目（tier 問わず）。cloud は空でも参照起草対象。
    // ★5（過剰要点疑い）を先頭に。
    return rows
      .filter(
        (r) =>
          r.answerReview !== "approved" &&
          (r.expected === "cloud" || (r.referencePoints?.length ?? 0) > 0),
      )
      .sort((a, b) => starCount(b) - starCount(a) || byId(a, b));
  }
  // labels: 既定は edge or borderline（FNリスク+判断割れ）。--all で全件。未承認のみ。
  return rows
    .filter((r) => r.reviewStatus !== "approved")
    .filter((r) => showAll || r.expected === "edge" || r.borderline)
    .sort(byId);
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  edge: (s: string) => `\x1b[36m${s}\x1b[0m`,
  cloud: (s: string) => `\x1b[33m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
};
const tierColor = (t: Tier) => (t === "edge" ? C.edge(t) : C.cloud(t));

function render(r: Row, i: number, total: number) {
  console.clear();
  console.log(C.bold(`Dataset A レビュー [${refsMode ? "refs/Pass2" : "labels/Pass1"}]  ${i + 1}/${total}`));
  console.log(C.dim("─".repeat(60)));
  console.log(`${C.bold(r.id)}  [${r.category}]  expected=${tierColor(r.expected)}  src=${r.answerSource}  ${r.borderline ? C.bold("⚑borderline") : ""}`);
  console.log(`Q: ${r.query}`);
  if (r.note) console.log(C.dim(`note: ${r.note}`));
  if (refsMode) {
    console.log(C.dim("referencePoints（★=中心要点・全充足で sufficient）:"));
    (r.referencePoints ?? []).forEach((p, n) =>
      console.log(`  ${n + 1}. ${p.startsWith("★") ? C.bold(p) : C.dim(p)}`),
    );
    if (r.answer) console.log(C.dim(`answer: ${r.answer.slice(0, 160)}${r.answer.length > 160 ? "…" : ""}`));
  }
  console.log(C.dim("─".repeat(60)));
  console.log(
    refsMode
      ? "a=参照承認  1-9=★トグル  r=reject  s=skip  q=保存して終了"
      : "a=ラベル承認  e=edge↔cloud反転  r=reject  s=skip  q=保存して終了",
  );
}

function setupKeys() {
  readline.emitKeypressEvents(process.stdin);
  if (!process.stdin.isTTY) {
    console.error("対話モードには TTY が必要です。実ターミナルで実行してください。");
    process.exit(1);
  }
  process.stdin.setRawMode(true);
}
function nextKey(): Promise<{ name?: string; ctrl?: boolean; sequence?: string }> {
  return new Promise((resolve) => {
    const onKey = (_s: string, k: { name?: string; ctrl?: boolean; sequence?: string }) => {
      process.stdin.off("keypress", onKey);
      resolve(k ?? {});
    };
    process.stdin.on("keypress", onKey);
  });
}

async function main() {
  const wl = worklist();
  console.log(
    `対象 ${wl.length}件（${refsMode ? "cloud未承認・★5優先" : showAll ? "全未承認" : "edge/borderline 未承認"}）。` +
      ` 全${rows.length}件中。`,
  );
  if (dry) {
    const edgeN = wl.filter((r) => r.expected === "edge").length;
    const borderN = wl.filter((r) => r.borderline).length;
    const star5 = wl.filter((r) => starCount(r) === 5).length;
    console.log(
      `[--dry] 対象内訳: edge=${edgeN} / borderline=${borderN}` +
        (refsMode ? ` / ★5=${star5}` : ""),
    );
    return;
  }
  if (wl.length === 0) {
    console.log(C.ok("レビュー対象なし（全て承認済み？）。check:data を実行してください。"));
    return;
  }
  console.log("Enter で開始…");
  setupKeys();
  await nextKey();

  let i = 0;
  let approved = 0;
  let flipped = 0;
  let rejected = 0;
  while (i < wl.length) {
    const r = wl[i]!;
    render(r, i, wl.length);
    const k = await nextKey();
    if (k.ctrl && k.name === "c") break;
    const key = k.name ?? k.sequence ?? "";
    if (key === "q") break;
    if (key === "s") {
      i++;
      continue;
    }
    if (key === "r") {
      if (refsMode) r.answerReview = "rejected";
      else r.reviewStatus = "rejected";
      rejected++;
      persist();
      i++;
      continue;
    }
    if (key === "a") {
      if (refsMode) r.answerReview = "approved";
      else r.reviewStatus = "approved";
      approved++;
      persist();
      i++;
      continue;
    }
    if (!refsMode && key === "e") {
      // ラベル反転＋answerSource を既定整合（cloud→reasoning / edge→general）。
      r.expected = r.expected === "edge" ? "cloud" : "edge";
      r.answerSource = r.expected === "edge" ? "general" : "reasoning";
      flipped++;
      persist();
      continue; // 同じ項目を再表示（反転後に a で承認）
    }
    if (refsMode && /^[1-9]$/.test(key)) {
      const idx = Number(key) - 1;
      const pts = r.referencePoints ?? [];
      if (pts[idx] !== undefined) {
        pts[idx] = pts[idx]!.startsWith("★") ? pts[idx]!.slice(1) : "★" + pts[idx]!;
        r.referencePoints = pts;
        persist();
      }
      continue; // 同じ項目を再表示
    }
    // 未知キーは無視して再表示
  }

  persist();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  console.clear();
  console.log(C.bold("レビュー中断/完了"));
  console.log(`承認=${approved} 反転=${flipped} reject=${rejected} / 残り未処理=${wl.length - i}`);
  const apprLabels = rows.filter((r) => r.reviewStatus === "approved").length;
  const apprRefs = rows.filter((r) => r.answerReview === "approved").length;
  console.log(`累計: reviewStatus approved=${apprLabels} / answerReview approved=${apprRefs}（全${rows.length}）`);
  console.log(C.dim(`保存先: ${DST}`));
  console.log(C.bold("→ 次: npm run check:data -w @hybrid/api で機械検証"));
  process.exit(0);
}

main();
