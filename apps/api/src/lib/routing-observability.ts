// Router Observability（MLOps）: 段1の振り分け判定を記録する seam。
//   - 二刀流: createApp(resolvers) で RoutingLogger を注入（Node=Postgres / Workers=no-op→将来 Analytics Engine）。
//   - emit はリクエスト遅延に乗せない fire-and-forget（失敗してもリクエストは止めない）。
//   - PII: query_ref は sha256 先端のみ。全文・先頭文字は本体に残さない（介護ドメインは冒頭に氏名/病名が来やすい）。
import type { DB } from "@/db/schema";
import { routingDecisions } from "@/db/schema";
import type { RoutingDecision } from "@/lib/routing-model";

export type RoutingLogEntry = RoutingDecision & {
  reqId: string;
  ts: number; // epoch ms
  queryRef: string;
};

export interface RoutingLogger {
  log(entry: RoutingLogEntry): void;
}

/** 既定（未注入時・Workers MVP）。何もしない。 */
export const noopRoutingLogger: RoutingLogger = { log() {} };

/** RoutingLogEntry を routing_decisions の行に変換（純関数＝テスト可能）。 */
export function routingDecisionToRow(
  e: RoutingLogEntry,
): typeof routingDecisions.$inferInsert {
  return {
    reqId: e.reqId,
    ts: new Date(e.ts),
    queryRef: e.queryRef,
    method: e.stage1.method,
    score: e.stage1.score,
    threshold: e.stage1.threshold,
    margin: e.stage1.margin,
    simCloud: e.stage1.simCloud,
    simEdge: e.stage1.simEdge,
    edgeConfidence: e.stage2?.edgeConfidence ?? null,
    escalated: e.stage2?.escalated ?? null,
    guardrailEsc: e.stage2?.guardrailEscalated ?? null,
    served: e.served,
    embedModel: e.versions.embedModel,
    classifierVersion: e.versions.classifierVersion,
    genModel: e.versions.genModel,
    latencyEmbed: e.latencyMs.embed,
    latencyGen: e.latencyMs.gen,
    latencyTotal: e.latencyMs.total,
  };
}

/** Node(dev): Postgres `routing_decisions` へ非同期 insert（fire-and-forget）。 */
export function drizzleRoutingLogger(db: DB): RoutingLogger {
  return {
    log(e) {
      void (async () => {
        try {
          await db.insert(routingDecisions).values(routingDecisionToRow(e));
        } catch {
          // テーブル未作成/DB不調でもリクエストは止めない（観測は best-effort）。
        }
      })();
    },
  };
}

/** PII 非保持の query 参照（sha256 先端16hex）。flywheel ラベリング時は別ストアから全文参照する想定。 */
export async function queryRef(prompt: string): Promise<string> {
  const data = new TextEncoder().encode(prompt);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
