// Router Observability（MLOps）: /ai/qa の判定・検索・推論メタを記録する seam。
//   - 二刀流: createApp(resolvers) で RoutingLogger を注入（Node=Postgres / Workers=no-op→将来 Analytics Engine）。
//   - emit はリクエスト遅延に乗せない fire-and-forget（失敗してもリクエストは止めない）。
//   - PII: query_ref は sha256 先端のみ。回答本文も sha256 先端(answerRef)。retrieved は srcId のみ。
//     全文・先頭文字は本体に残さない（介護ドメインは冒頭に氏名/病名が来やすい）。
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
    // 段0 RAG 検索
    topScore: e.retrieval.topScore,
    domain: e.retrieval.domain,
    // jsonb 列。配列をそのまま渡す（drizzle が JSON シリアライズ）。
    retrievedSrcIds: e.retrieval.retrieved.map((r) => r.srcId),
    retrievedScores: e.retrieval.retrieved.map((r) => r.score),
    latencyEmbed: e.retrieval.latencyEmbed,
    embedModel: e.retrieval.embedModel, // embedModel は retrieval が single source
    // 段1 Capability Router（ドメイン内のみ LLM 分類。general/エラー時 null）
    // 現在は LLM few-shot 分類のため score/margin/sim は null（将来 埋め込み分類器導入時は埋まる）
    method: e.stage1?.method ?? null,
    route: e.stage1?.route ?? null,
    routeReason: e.stage1?.routeReason ?? null,
    score: null,
    threshold: null,
    margin: null,
    simCloud: null,
    simEdge: null,
    // 段2 cascade（general/エラー時 null）
    edgeConfidence: e.stage2?.edgeConfidence ?? null,
    escalated: e.stage2?.escalated ?? null,
    guardrailEsc: e.stage2?.guardrailEscalated ?? null,
    served: e.served,
    // 出力・エラー
    answerRef: e.answerRef,
    errorCode: e.errorCode,
    // versions/latency。embedModel/latencyEmbed は retrieval を single source とする（上記で記録済み）。
    classifierVersion: e.versions.classifierVersion,
    genModel: e.versions.genModel,
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
        } catch (err) {
          // テーブル未作成/DB不調でもリクエストは止めない（観測は best-effort）。
          // dev では握り潰しに気づけるよう警告（本番ログ汚染を避け production では出さない）。
          if (process.env.NODE_ENV !== "production") {
            console.warn(`[routing-observability] insert 失敗（観測のみ・本処理は継続）: ${String(err)}`);
          }
        }
      })();
    },
  };
}

/** PII 非保持の参照値（sha256 先端16hex）。本文は保持しない。query/answer 共通。 */
export async function hashRef(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** query 全文の参照（flywheel ラベリング時は別ストアから全文参照する想定）。 */
export const queryRef = hashRef;

/** 回答本文の参照。 */
export const answerRef = hashRef;
