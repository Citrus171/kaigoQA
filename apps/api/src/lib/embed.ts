// Embedding プロバイダ抽象化（ADR 0001 制約3: embedding取得も dev/prod 二刀流に乗せる）。
// dev(Node): ローカル Ollama /api/embed。
// prod(Workers): Workers AI binding(@cf/baai/bge-* 等)。後続タスク。
//
// 返すベクトルは L2 正規化済み（コサイン類似 = 内積で計算できるようにする）。

import { InferenceError } from "@/lib/inference";

export interface EmbedProvider {
  readonly name: string;
  /** 複数テキストを一括埋め込み。返り値は各々 L2 正規化済み。 */
  embed(texts: string[]): Promise<number[][]>;
}

/** L2 正規化（ゼロベクトルはそのまま返す）。 */
export function l2normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const norm = Math.sqrt(s);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

/** 正規化済みベクトル同士のコサイン類似 = 内積。 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`次元不一致: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** dev: ローカル Ollama でテキストを埋め込む。 */
export class OllamaEmbedProvider implements EmbedProvider {
  readonly name: string;
  constructor(
    private readonly url = process.env.OLLAMA_URL ?? "http://localhost:11434",
    private readonly model = process.env.OLLAMA_EMBED_MODEL ?? "llama3.2:1b",
  ) {
    this.name = `ollama-embed:${this.model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const BATCH = 40;
    if (texts.length <= BATCH) return this._embed(texts);
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      results.push(...(await this._embed(batch)));
    }
    return results;
  }

  private async _embed(texts: string[]): Promise<number[][]> {
    let res: Response;
    try {
      res = await fetch(`${this.url}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } catch (e) {
      throw new InferenceError(this.name, "Ollama(embed) に接続できません", "connrefused", undefined, e);
    }
    if (!res.ok) {
      throw new InferenceError(
        this.name,
        `Ollama(embed) が ${res.status} を返しました`,
        "http",
        res.status,
      );
    }
    const data = (await res.json()) as { embeddings?: number[][] };
    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new InferenceError(this.name, "embed 応答の形式が不正です", "badformat");
    }
    return data.embeddings.map(l2normalize);
  }
}
