import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectRiskyAssertion } from "../src/lib/guardrail";

interface EvalRow {
  id: string;
  query: string;
  expected: string;
  category: string;
  genFailed: boolean;
  answer: string;
  latencyMs: number;
  verdict: {
    factual: boolean;
    overreach: boolean;
    sufficient: boolean;
    category: string;
    reason: string;
  } | null;
  good: boolean;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "data");

function loadJsonl(filename: string): EvalRow[] {
  const text = readFileSync(join(dataDir, filename), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as EvalRow);
}

type DegradeReason =
  | "genFailed"
  | "answer_empty"
  | "answer_too_short"
  | "risky_assertion"
  | "";

function isDegraded(row: EvalRow): DegradeReason {
  if (row.genFailed) return "genFailed";
  if (!row.answer || row.answer.trim().length === 0) return "answer_empty";
  if (row.answer.trim().length < 6) return "answer_too_short";
  return "";
}

function isRisky(row: EvalRow): boolean {
  return detectRiskyAssertion(row.answer).risky;
}

interface CascadeResult {
  id: string;
  query: string;
  category: string;
  edgeGood: boolean;
  cloudGood: boolean;
  edgeVerdict: string;
  cloudVerdict: string;
  edgeLatency: number;
  cloudLatency: number;
  cascade: "edge" | "cloud";
  cedeReason: DegradeReason | "risky";
  good: boolean;
  verdict: string;
  outcome: "keep-good" | "keep-bad" | "escaped-bad" | "rescued" | "spoil";
}

const pct = (n: number, d: number) =>
  d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`;

function main() {
  const edge = loadJsonl("rag-mvp-edge-out44.jsonl");
  const cloud = loadJsonl("rag-mvp-cloud-out44.jsonl");

  const cloudMap = new Map(cloud.map((c) => [c.id, c]));

  const results: CascadeResult[] = [];

  for (const e of edge) {
    const c = cloudMap.get(e.id);
    if (!c) {
      console.error(`Missing cloud entry for ${e.id}, skipping`);
      continue;
    }

    const degradeReason = isDegraded(e);
    const risky = !degradeReason && isRisky(e); // degraded判定が優先
    const cascade = degradeReason || risky ? "cloud" : "edge";
    const cedeReason = degradeReason || (risky ? "risky" : "");

    const chosenRow = cascade === "edge" ? e : c;

    // outcome classification
    // keep-good: edge確定でedgeもcloudもgood → 損なし
    // keep-bad:  edge確定でedgeがbad → 素通りbad（A方式の構造的弱点）
    // escaped-bad: edge確定でedgeがbadだがcloudもbad → どっちみちbad
    // rescued:    cloudフォールバックでcloudがgood → 救済成功
    // spoil:      cloudフォールバックでcloudがbad、edgeはgood → エスカレ損
    let outcome: CascadeResult["outcome"];
    if (cascade === "edge") {
      if (e.good) {
        outcome = "keep-good";
      } else {
        outcome = c.good ? "keep-bad" : "escaped-bad";
      }
    } else {
      if (c.good && !e.good) {
        outcome = "rescued";
      } else if (!c.good && e.good) {
        outcome = "spoil";
      } else if (c.good && e.good) {
        outcome = "keep-good"; // フォールバックしたが実質どちらでもgood
      } else {
        outcome = "escaped-bad"; // どちらもbad
      }
    }

    results.push({
      id: e.id,
      query: e.query,
      category: e.category,
      edgeGood: e.good,
      cloudGood: c.good,
      edgeVerdict: e.verdict?.category ?? "genFailed",
      cloudVerdict: c.verdict?.category ?? "genFailed",
      edgeLatency: e.latencyMs,
      cloudLatency: c.latencyMs,
      cascade,
      cedeReason,
      good: chosenRow.good,
      verdict: chosenRow.verdict?.category ?? "genFailed",
      outcome,
    });
  }

  const total = results.length;
  const goodCount = results.filter((r) => r.good).length;
  const goodRate = goodCount / total;

  // cascade breakdown
  const edgeConfirmed = results.filter((r) => r.cascade === "edge");
  const cloudFallback = results.filter((r) => r.cascade === "cloud");
  const riskyFallback = results.filter((r) => r.cedeReason === "risky");
  const degradeFallback = results.filter(
    (r) => r.cedeReason && r.cedeReason !== "risky",
  );

  // outcome detail
  const keepGood = results.filter((r) => r.outcome === "keep-good");
  const keepBad = results.filter((r) => r.outcome === "keep-bad");
  const escapedBad = results.filter((r) => r.outcome === "escaped-bad");
  const rescued = results.filter((r) => r.outcome === "rescued");
  const spoil = results.filter((r) => r.outcome === "spoil");

  // latency estimate (cascade = edge latency; when fallback, add cloud latency)
  const avgCascadeLatency =
    results.reduce((sum, r) => {
      if (r.cascade === "edge") return sum + r.edgeLatency;
      // シリアルカスケード: edge失敗後にcloud実行 → edge + cloud
      return sum + r.edgeLatency + r.cloudLatency;
    }, 0) / total;

  // === OUTPUT MARKDOWN ===
  const lines: string[] = [];

  lines.push("# A方式カスケード シミュレーション結果");
  lines.push("");
  lines.push(`**入力**: rag-mvp-edge-out44.jsonl / rag-mvp-cloud-out44.jsonl（41件同id整列）`);
  lines.push("");
  lines.push(`**カスケードロジック**: edge回答に 退化(genFailed / trim空 / length<6) または \`detectRiskyAssertion\`(risky) があれば cloud フォールバック、両偽なら edge 確定。`);
  lines.push("");
  lines.push("## 結果サマリ");
  lines.push("");
  lines.push("| 指標 | 値 |");
  lines.push("|------|-----|");
  lines.push(`| カスケード後 good 件数 | ${goodCount}/${total} |`);
  lines.push(`| カスケード後 good 率 | ${pct(goodCount, total)} |`);
  lines.push(`| 参考: edge 単体 good 率 | ${pct(edge.filter((e) => e.good).length, total)} |`);
  lines.push(`| 参考: cloud 単体 good 率 | ${pct(cloud.filter((c) => c.good).length, total)} |`);
  lines.push(`| カスケード推定平均レイテンシ | ${(avgCascadeLatency / 1000).toFixed(1)}s`);

  // Detailed timing by scenario
  const edgeOnlyLatency =
    edgeConfirmed.length > 0
      ? edgeConfirmed.reduce((s, r) => s + r.edgeLatency, 0) / edgeConfirmed.length
      : 0;
  const fallbackLatency =
    cloudFallback.length > 0
      ? cloudFallback.reduce((s, r) => s + r.edgeLatency + r.cloudLatency, 0) /
        cloudFallback.length
      : 0;
  lines.push(`| 　edge確定時の平均レイテンシ | ${(edgeOnlyLatency / 1000).toFixed(1)}s`);
  lines.push(`| 　cloudフォールバック時平均レイテンシ | ${(fallbackLatency / 1000).toFixed(1)}s`);

  lines.push("");
  lines.push("## フォールバック内訳");
  lines.push("");
  lines.push(`- edge 確定: **${edgeConfirmed.length}件**（${pct(edgeConfirmed.length, total)}）`);
  lines.push(`- cloud フォールバック: **${cloudFallback.length}件**（${pct(cloudFallback.length, total)}）`);

  if (degradeFallback.length > 0) {
    lines.push(`  - うち退化要因: ${degradeFallback.length}件`);
    lines.push("");
    lines.push("### 退化フォールバック詳細");
    for (const r of degradeFallback) {
      lines.push(`- \`${r.id}\`: ${r.cedeReason} → cloud採用（edge=${r.edgeVerdict}→cloud=${r.cloudVerdict}）`);
    }
  }

  if (riskyFallback.length > 0) {
    lines.push(`  - うち risky assertion: ${riskyFallback.length}件`);
    lines.push("");
    lines.push("### risky assertion フォールバック詳細");
    const reasons = new Map<string, string[]>();
    for (const r of riskyFallback) {
      const detail = detectRiskyAssertion(
        loadJsonl("rag-mvp-edge-out44.jsonl").find((x) => x.id === r.id)!.answer,
      );
      for (const reason of detail.reasons) {
        if (!reasons.has(reason)) reasons.set(reason, []);
        reasons.get(reason)!.push(r.id);
      }
      lines.push(`- \`${r.id}\`: ${detail.reasons.join(", ")} → cloud採用（edge=${r.edgeVerdict}→cloud=${r.cloudVerdict} / ${r.outcome}）`);
    }
  }

  if (cloudFallback.length === 0) {
    lines.push("  - フォールバックなし");
  }

  lines.push("");
  lines.push("## 損得分析");
  lines.push("");
  lines.push("| カテゴリ | 件数 | 内容 |");
  lines.push("|----------|------|------|");
  lines.push(`| keep-good | ${keepGood.length} | edge確定でgood（正答維持） |`);
  lines.push(`| **keep-bad（素通りbad）** | **${keepBad.length}** | **edge確定だがbad = A方式の構造的弱点** |`);
  lines.push(`| escaped-bad | ${escapedBad.length} | どちらもbad（不可避） |`);
  lines.push(`| rescued（救済） | ${rescued.length} | cloudフォールバックでbad→goodに救済 |`);
  lines.push(`| spoil（エスカレ損） | ${spoil.length} | cloudフォールバックでgood→badに改悪 |`);

  lines.push("");
  lines.push("### 損得分解");
  lines.push("");

  const edgeGoodTotal = edge.filter((e) => e.good).length;
  const cascadeGoodTotal = goodCount;
  const netGain = cascadeGoodTotal - edgeGoodTotal;
  lines.push(`| 指標 | 値 |`);
  lines.push(`|------|-----|`);
  lines.push(`| edge 単体 good | ${edgeGoodTotal}件 (${pct(edgeGoodTotal, total)}) |`);
  lines.push(`| カスケード後 good | ${cascadeGoodTotal}件 (${pct(cascadeGoodTotal, total)}) |`);
  lines.push(`| ネット増減 | ${netGain >= 0 ? "+" : ""}${netGain}件 |`);
  lines.push(`| 救済成功 | ${rescued.length}件 +${rescued.length} good |`);
  lines.push(`| エスカレ損 | ${spoil.length}件 -${spoil.length} good |`);

  if (rescued.length > 0) {
    lines.push("");
    lines.push("#### 救済成功（cloudフォールバックでbad→goodに救済）");
    lines.push("");
    for (const r of rescued) {
      lines.push(`- \`${r.id}\` [${r.category}] "${r.query.slice(0, 60)}..." : edge=${r.edgeVerdict}→cloud=${r.cloudVerdict}`);
    }
  }

  if (spoil.length > 0) {
    lines.push("");
    lines.push("#### エスカレ損（cloudフォールバックでgood→badに改悪）");
    lines.push("");
    for (const r of spoil) {
      lines.push(`- \`${r.id}\` [${r.category}] "${r.query.slice(0, 60)}..." : edge=${r.edgeVerdict}→cloud=${r.cloudVerdict} (${r.cedeReason})`);
    }
  }

  if (keepBad.length > 0) {
    lines.push("");
    lines.push("#### 素通りbad（A方式の構造的弱点 = 退化もriskyもなくedge確定するが実はbad）");
    lines.push("");
    for (const r of keepBad) {
      lines.push(`- \`${r.id}\` [${r.category}] "${r.query.slice(0, 60)}..." : edge=${r.edgeVerdict}`);
    }
  }

  lines.push("");
  lines.push("## 全41件 判定一覧");
  lines.push("");
  lines.push("| id | category | outcome | cascade | edge→cloud | reason |");
  lines.push("|----|----------|---------|---------|-------------|--------|");
  for (const r of results) {
    const eg = r.edgeGood ? "G" : "B";
    const cg = r.cloudGood ? "G" : "B";
    lines.push(
      `| \`${r.id}\` | ${r.category} | ${r.outcome} | ${r.cascade} | ${eg}→${cg} | ${r.cedeReason || r.verdict} |`,
    );
  }

  const md = lines.join("\n");
  console.log(md);
}

main();
