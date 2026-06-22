// Cloudflare Workers AI reranker（@cf/baai/bge-reranker-base）。
//
// query + contexts を受け取り、各 context の relevance score を返す cross-attention モデル。
// dev では HTTP API 経由。prod では Workers AI binding に差し替え可能（RerankProvider 抽象）。

import { InferenceError } from "@/lib/inference";
import type { RerankProvider } from "@/lib/retriever";
import type { RetrievedChunk } from "@/lib/rag";

const CF_RERANK_MODEL = "@cf/baai/bge-reranker-base";

export class CfBgeRerankProvider implements RerankProvider {
  readonly name = `cf:${CF_RERANK_MODEL}`;
  private readonly url: string;

  constructor(
    private readonly accountId = process.env.CF_ACCOUNT_ID,
    private readonly token = process.env.CF_API_TOKEN,
    private readonly timeoutMs = Number(process.env.CF_RERANK_TIMEOUT_MS ?? 30000),
  ) {
    this.url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${CF_RERANK_MODEL}`;
  }

  async rerank(query: string, chunks: RetrievedChunk[], topK: number): Promise<RetrievedChunk[]> {
    if (!this.accountId || !this.token) {
      throw new InferenceError(this.name, "CF_ACCOUNT_ID / CF_API_TOKEN が未設定です", "config");
    }

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          contexts: chunks.map((c) => ({ text: c.text })),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const isTimeout = e instanceof Error && e.name === "TimeoutError";
      throw new InferenceError(
        this.name,
        isTimeout ? `CF reranker が ${this.timeoutMs}ms 以内に応答しませんでした` : "Cloudflare AI に接続できません",
        isTimeout ? "timeout" : "connrefused",
        undefined,
        e,
      );
    }

    if (!res.ok) {
      throw new InferenceError(this.name, `CF AI が ${res.status} を返しました`, "http", res.status);
    }

    const json = (await res.json()) as {
      success?: boolean;
      result?: { response?: { id: number; score: number }[] };
    };
    const response = json.result?.response;
    if (!response || response.length !== chunks.length) {
      throw new InferenceError(this.name, "CF reranker 応答の形式が不正です", "badformat");
    }

    return response
      .filter((r) => r.id >= 0 && r.id < chunks.length)
      .map((r) => ({ ...chunks[r.id]!, score: r.score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
