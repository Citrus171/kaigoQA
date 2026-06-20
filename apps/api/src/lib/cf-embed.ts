// Cloudflare Workers AI 埋め込みプロバイダ（bge-m3, 1024次元）。
//
// RAG コーパス（models/rag/corpus.json）は CF bge-m3 で事前計算されているため、
// serving のクエリ埋め込みも同じモデルで取得して埋め込み空間を一致させる必要がある
// （Ollama の埋め込みでは次元・空間が異なり cosine が無意味になる）。
//
// dev では HTTP API（api.cloudflare.com/.../ai/run/@cf/baai/bge-m3）を叩く。
// prod(Workers) では将来 c.env.AI binding に差し替える seam を残す（EmbedProvider 抽象）。

import { InferenceError } from "@/lib/inference";
import { l2normalize, type EmbedProvider } from "@/lib/embed";

export const CF_EMBED_MODEL = "@cf/baai/bge-m3";

/** dev: Cloudflare Workers AI の bge-m3 を HTTP 経由で叩く埋め込みプロバイダ。 */
export class CfBgeM3EmbedProvider implements EmbedProvider {
  readonly name = `cf:${CF_EMBED_MODEL}`;
  private readonly url: string;

  constructor(
    private readonly accountId = process.env.CF_ACCOUNT_ID,
    private readonly token = process.env.CF_API_TOKEN,
    private readonly timeoutMs = Number(process.env.CF_EMBED_TIMEOUT_MS ?? 30000),
  ) {
    this.url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${CF_EMBED_MODEL}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.accountId || !this.token) {
      throw new InferenceError(
        this.name,
        "CF_ACCOUNT_ID / CF_API_TOKEN が未設定です",
      );
    }
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        // CF bge-m3 は { text: string[] } を受ける。
        body: JSON.stringify({ text: texts }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const reason =
        e instanceof Error && e.name === "TimeoutError"
          ? `CF 埋め込みが ${this.timeoutMs}ms 以内に応答しませんでした`
          : "Cloudflare AI に接続できません";
      throw new InferenceError(this.name, reason, e);
    }
    if (!res.ok) {
      throw new InferenceError(this.name, `CF AI が ${res.status} を返しました`);
    }
    const json = (await res.json()) as {
      success?: boolean;
      result?: { data?: number[][] };
    };
    const data = json.result?.data;
    if (!data || data.length !== texts.length) {
      throw new InferenceError(this.name, "CF 埋め込み応答の形式が不正です");
    }
    // コーパス成果物の cosine と揃えるため L2 正規化（cosine() は内積前提）。
    return data.map(l2normalize);
  }
}
