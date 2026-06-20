// 本番 /ai/qa フローに gold-a 41件を逐次投入し、tier 分布・latency 分布を実測する。
// judge 採点はしない（tier/route/latency/空答のみ）。out/45 シミュレーションの実機検証版。
import fs from "node:fs";

const BASE = "http://localhost:8787";
const DISCLAIMER =
  "※AIによる参考情報です。最終的な判断は介護・医療・法務の専門職にご確認ください。";

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "demo@example.com", password: "password" }),
  });
  if (!r.ok) throw new Error(`login failed ${r.status}`);
  return (await r.json()).token;
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const stat = (arr) =>
  arr.length
    ? `p50=${pct(arr, 50)} / p95=${pct(arr, 95)} / max=${Math.max(...arr)} (n=${arr.length})`
    : "(n=0)";

const items = fs
  .readFileSync("eval/data/rag-mvp-edge-out44.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const token = await login();
const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };

const results = [];
for (const it of items) {
  const t0 = Date.now();
  let o = {}, status = 0;
  try {
    const res = await fetch(`${BASE}/ai/qa`, {
      method: "POST",
      headers,
      body: JSON.stringify({ question: it.query }),
    });
    status = res.status;
    o = await res.json();
  } catch (e) {
    o = { _err: String(e) };
  }
  const latency = Date.now() - t0;
  const ans = (o.answer || "").replace(DISCLAIMER, "").trim();
  const empty = ans.length < 6;
  const r = {
    id: it.id,
    route: o.route ?? "ERR",
    tier: o.tier ?? "ERR",
    escalated: o.safety?.escalatedByGuardrail ?? false,
    latency,
    status,
    empty,
  };
  results.push(r);
  console.log(
    `${r.id}\t${r.route}/${r.tier}\t${latency}ms\t${status}${empty ? "\tEMPTY" : ""}`,
  );
}

// ── 集計 ──
const count = (pred) => results.filter(pred).length;
const kqa = results.filter((r) => r.route === "knowledge_qa");
const esc = results.filter((r) => r.route === "escalate");
const gen = results.filter((r) => r.route === "general");
const kqaEdge = kqa.filter((r) => r.tier === "edge").length;
const kqaCloud = kqa.filter((r) => r.tier === "cloud").length;
const latAll = results.map((r) => r.latency);
const latEdge = results.filter((r) => r.tier === "edge").map((r) => r.latency);
const latCloud = results.filter((r) => r.tier === "cloud").map((r) => r.latency);
const errors = results.filter((r) => r.status !== 200);

const md = `# 46: 本番 /ai/qa フロー実測 (gold-a 41件・tier/latency 分布・judge無し)

\`${new Date().toISOString()}\` / 構成: edge=Workers AI Gemma4 thinkOFF / cloud=OpenCode deepseek-v4-flash / embed=CF bge-m3

## route 分布 (段1 ドメイン判定 + 段2 classifyRoute)
- knowledge_qa: ${kqa.length} / escalate: ${esc.length} / general: ${gen.length} / ERR: ${count((r) => r.route === "ERR")}

## tier 分布
- edge: ${count((r) => r.tier === "edge")} / cloud: ${count((r) => r.tier === "cloud")} / ERR: ${count((r) => r.tier === "ERR")}

## A方式 cascade 実機 fallback 率 (knowledge_qa のみ)
- edge 確定: ${kqaEdge} / ${kqa.length}
- cloud fallback: ${kqaCloud} / ${kqa.length} = ${kqa.length ? ((kqaCloud / kqa.length) * 100).toFixed(1) : 0}%
  - (out/45 シミュレーションは fallback 0% だった。実機での差分に注目)
- guardrail エスカレ件数(escalatedByGuardrail かつ knowledge_qa): ${kqa.filter((r) => r.escalated).length}

## 空答率
- empty: ${count((r) => r.empty)} / ${results.length}

## latency 分布 (ms)
- 全体: ${stat(latAll)}
- edge tier: ${stat(latEdge)}
- cloud tier: ${stat(latCloud)}

## エラー (status != 200)
- ${errors.length ? errors.map((r) => `${r.id}:${r.status}`).join(", ") : "なし"}
`;

fs.writeFileSync("eval/out/46-qa-flow-tier-dist.md", md);
console.log("\n========\n" + md);
