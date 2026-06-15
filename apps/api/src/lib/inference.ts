// 推論プロバイダ抽象化（dev/prod 両対応の要）。
// dev(Node): このPCの Ollama を直接呼ぶ。
// escalation(cloud): OpenCode Go（OpenAI互換ゲートウェイ・定額）。
// prod(Workers)の edge SLM = Workers AI binding は後続タスク（localhost不可のため別実装）。

export interface InferProvider {
  readonly name: string;
  infer(prompt: string): Promise<{ text: string; confidence: number }>;
}

export class InferenceError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "InferenceError";
  }
}

// confidence は 0-1 にクランプ。SLM の自己申告は範囲外/非数を返しうる。
function clampConfidence(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * dev edge SLM: ローカル Ollama (llama3.2:1b)。
 * format:"json" で {answer, confidence} を構造化出力させる。
 */
export class OllamaProvider implements InferProvider {
  readonly name = "ollama:llama3.2:1b";
  constructor(
    private readonly url = process.env.OLLAMA_URL ?? "http://localhost:11434",
    private readonly model = "llama3.2:1b",
  ) {}

  async infer(prompt: string) {
    let res: Response;
    try {
      res = await fetch(`${this.url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: `${prompt}\n\nJSONで {"answer": string, "confidence": 0-1の数値} のみ返答。`,
          format: "json",
          stream: false,
        }),
      });
    } catch (e) {
      throw new InferenceError(this.name, "Ollama に接続できません", e);
    }
    if (!res.ok) {
      throw new InferenceError(this.name, `Ollama が ${res.status} を返しました`);
    }
    const data = (await res.json()) as { response?: string };
    let parsed: { answer?: unknown; confidence?: unknown };
    try {
      parsed = JSON.parse(data.response ?? "{}");
    } catch (e) {
      throw new InferenceError(this.name, "Ollama 応答の JSON 解析に失敗", e);
    }
    return {
      text: String(parsed.answer ?? ""),
      confidence: clampConfidence(parsed.confidence),
    };
  }
}

/**
 * escalation(cloud LLM): OpenCode Go（OpenAI互換・定額）。
 * HTTP 呼び出しなので dev/prod 両方で動く（Workers からも到達可）。
 * confidence はゲートウェイから返らないため固定の高値を割り当てる（PoC）。
 */
export class OpenCodeProvider implements InferProvider {
  readonly name = "opencode-go:deepseek-v4-flash";
  // クラウドLLMはエッジより信頼度が高い前提で固定値（confidence算出は本番課題）。
  private static readonly CLOUD_CONFIDENCE = 0.8;
  constructor(
    private readonly key = process.env.OPENCODE_API_KEY,
    private readonly url = "https://opencode.ai/zen/go/v1/chat/completions",
    private readonly model = "deepseek-v4-flash",
  ) {}

  async infer(prompt: string) {
    if (!this.key) {
      throw new InferenceError(this.name, "OPENCODE_API_KEY が未設定です");
    }
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch (e) {
      throw new InferenceError(this.name, "OpenCode Go に接続できません", e);
    }
    if (!res.ok) {
      throw new InferenceError(
        this.name,
        `OpenCode Go が ${res.status} を返しました`,
      );
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new InferenceError(this.name, "OpenCode Go 応答の形式が不正です");
    }
    return { text, confidence: OpenCodeProvider.CLOUD_CONFIDENCE };
  }
}
