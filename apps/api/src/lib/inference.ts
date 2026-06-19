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

// 介護一次対応の system prompt。事実不明は「施設にご確認ください」とし推測させない、
// 医療診断・法令断定を禁止（Layer2 ガードレールと方針を揃える）。
export const EDGE_SYSTEM_PROMPT =
  "あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で簡潔に(2〜3文)答えてください。" +
  "事実が確認できない場合や施設固有の情報は推測せず「施設にご確認ください」と述べること。" +
  "医療診断・投薬指示・法令の断定はしないこと。";

// 出力の自己申告 confidence は信頼できない（calibration eval）。代わりに「退化出力か否か」を
// 透過的なヒューリスティックで判定し、退化時は低 confidence にして段2でエスカレさせる。
const DEGENERATE = /^(true|false|null|undefined|\d+(\.\d+)?)$/i;
function outputConfidence(text: string): number {
  const t = text.trim();
  if (t === "" || t.length < 6 || DEGENERATE.test(t)) return 0; // 空/極短/型値 → 退化
  return 0.7; // 非退化（=形式的には回答できている。事実性は Layer2 で別途評価）。
}

/**
 * dev edge SLM: ローカル Ollama（既定 llama3.2:1b、env OLLAMA_GEN_MODEL で差替可）。
 * 自然文で一次回答を生成する（format:"json" は 1b で退化出力を招くため廃止）。
 * confidence は出力の妥当性ヒューリスティック（退化→0でエスカレ、それ以外0.7）。
 */
export class OllamaProvider implements InferProvider {
  readonly name: string;
  constructor(
    private readonly url = process.env.OLLAMA_URL ?? "http://localhost:11434",
    private readonly model = process.env.OLLAMA_GEN_MODEL ?? "llama3.2:1b",
  ) {
    this.name = `ollama:${this.model}`;
  }

  async infer(prompt: string) {
    let res: Response;
    try {
      res = await fetch(`${this.url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            { role: "system", content: EDGE_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        }),
      });
    } catch (e) {
      throw new InferenceError(this.name, "Ollama に接続できません", e);
    }
    if (!res.ok) {
      throw new InferenceError(this.name, `Ollama が ${res.status} を返しました`);
    }
    const data = (await res.json()) as { message?: { content?: unknown } };
    const text = String(data.message?.content ?? "").trim();
    if (text === "") {
      throw new InferenceError(this.name, "Ollama が空応答を返しました");
    }
    return { text, confidence: outputConfidence(text) };
  }
}

/**
 * edge SLM（本命・prod想定）: Cloudflare Workers AI の Gemma 4 26B A4B。
 * GPU 上で動くため CPU の Ollama より実用品質（ローカル CPU の Gemma4 は 0.36 tok/s で非現実的）。
 * HTTP 呼び出しなので dev/prod 両方で動く。応答は OpenAI 形式 choices[].message.content
 * （旧形式 result.response もフォールバック）。confidence は Ollama と同じ退化ヒューリスティック。
 */
export class WorkersAiProvider implements InferProvider {
  readonly name: string;
  private readonly url: string;
  constructor(
    private readonly accountId = process.env.CF_ACCOUNT_ID,
    private readonly token = process.env.CF_API_TOKEN,
    private readonly model = process.env.WORKERS_AI_EDGE_MODEL ??
      "@cf/google/gemma-4-26b-a4b-it",
    // thinking mode が reasoning にトークンを使うため content 用に余裕を持たせる（eval と統一）。
    private readonly maxTokens = Number(process.env.WORKERS_AI_MAX_TOKENS ?? 2048),
    private readonly timeoutMs = Number(process.env.WORKERS_AI_TIMEOUT_MS ?? 120000),
  ) {
    this.name = `workersai:${this.model}`;
    this.url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`;
  }

  async infer(prompt: string) {
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
        body: JSON.stringify({
          messages: [
            { role: "system", content: EDGE_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          max_tokens: this.maxTokens,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const reason =
        e instanceof Error && e.name === "TimeoutError"
          ? `Workers AI が ${this.timeoutMs}ms 以内に応答しませんでした`
          : "Cloudflare Workers AI に接続できません";
      throw new InferenceError(this.name, reason, e);
    }
    if (!res.ok) {
      throw new InferenceError(
        this.name,
        `Workers AI が ${res.status} を返しました`,
      );
    }
    const body = (await res.json()) as {
      result?: {
        choices?: { message?: { content?: string } }[];
        response?: string;
      };
    };
    const result = body.result ?? {};
    // Gemma 4 は OpenAI 形式 choices[].message.content。旧形式 response もフォールバック。
    const text = (
      result.choices?.[0]?.message?.content ??
      result.response ??
      ""
    ).trim();
    if (text === "") {
      throw new InferenceError(this.name, "Workers AI が空応答を返しました");
    }
    return { text, confidence: outputConfidence(text) };
  }
}

/**
 * escalation(cloud LLM): OpenCode Go（OpenAI互換・定額）。
 * HTTP 呼び出しなので dev/prod 両方で動く（Workers からも到達可）。
 * confidence はゲートウェイから返らないため固定の高値を割り当てる（PoC）。
 */
export class OpenCodeProvider implements InferProvider {
  readonly name: string;
  // クラウドLLMはエッジより信頼度が高い前提で固定値（confidence算出は本番課題）。
  private static readonly CLOUD_CONFIDENCE = 0.8;
  constructor(
    private readonly key = process.env.OPENCODE_API_KEY,
    private readonly url = "https://opencode.ai/zen/go/v1/chat/completions",
    // cloud生成 + LLM-as-Judge に使うモデル。env で上書き可（既定 deepseek-v4-pro）。
    // 介護保険ドメインは事実正確性が最優先のため flash ではなく pro を既定とする。
    private readonly model = process.env.OPENCODE_MODEL ?? "deepseek-v4-pro",
    // 応答が返らない1件で評価全体が無限停止するのを防ぐ。env で上書き可（既定60s）。
    private readonly timeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS ?? 60000),
  ) {
    this.name = `opencode-go:${this.model}`;
  }

  // system は任意。RAG 生成（Capability Router）は参考情報入りの system prompt を渡す。
  // 未指定なら従来どおり user メッセージのみ（/ai/ask のエスカレーションは無改修）。
  async infer(prompt: string, system?: string) {
    if (!this.key) {
      throw new InferenceError(this.name, "OPENCODE_API_KEY が未設定です");
    }
    const messages = system
      ? [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ]
      : [{ role: "user", content: prompt }];
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
          messages,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const reason = e instanceof Error && e.name === "TimeoutError"
        ? `OpenCode Go が ${this.timeoutMs}ms 以内に応答しませんでした`
        : "OpenCode Go に接続できません";
      throw new InferenceError(this.name, reason, e);
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

/**
 * 独立 LLM-as-Judge 用プロバイダ（OpenAI互換・既定 OpenRouter 経由 GPT-4o）。
 * 目的: 生成系(OpenCode/deepseek)と別系統の judge を注入し「自己採点バイアス」を除去する。
 * base/model/key は env で差替可能なので、OpenRouter経由(GPT-4o/Claude等)でも OpenAI直でも使える。
 * 生成には使わず再採点(rejudge)専用想定だが InferProvider 準拠なので judgeAnswer にそのまま渡せる。
 */
export class OpenRouterProvider implements InferProvider {
  readonly name: string;
  // judge 用途では confidence は使われない（judgeAnswer は .text のみ参照）。固定値。
  private static readonly JUDGE_CONFIDENCE = 0.9;
  constructor(
    private readonly key = process.env.OPENROUTER_API_KEY,
    // OpenAI互換の chat/completions エンドポイント。OpenAI直なら https://api.openai.com/v1/... を指定。
    private readonly url = process.env.JUDGE_BASE_URL ??
      "https://openrouter.ai/api/v1/chat/completions",
    // 既定は OpenRouter のモデルID。OpenAI直なら "gpt-4o"、Claudeなら "anthropic/claude-opus-4" 等。
    private readonly model = process.env.JUDGE_MODEL ?? "openai/gpt-4o",
    private readonly timeoutMs = Number(process.env.JUDGE_TIMEOUT_MS ?? 60000),
    // 採点温度。既定0=決定論寄り（再現性重視）。flip率モードは判定の揺れを測るため非0が必須
    // （rejudge が JUDGE_TEMPERATURE を設定する）。
    readonly temperature = Number(process.env.JUDGE_TEMPERATURE ?? 0),
  ) {
    this.name = `judge:${this.model}`;
  }

  async infer(prompt: string) {
    if (!this.key) {
      throw new InferenceError(this.name, "OPENROUTER_API_KEY が未設定です");
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
          // 既定は決定論寄り(0)。flip率モードは JUDGE_TEMPERATURE で非0に上げ判定の揺れを測る。
          temperature: this.temperature,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const reason = e instanceof Error && e.name === "TimeoutError"
        ? `judge API が ${this.timeoutMs}ms 以内に応答しませんでした`
        : "judge API に接続できません";
      throw new InferenceError(this.name, reason, e);
    }
    if (!res.ok) {
      throw new InferenceError(this.name, `judge API が ${res.status} を返しました`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new InferenceError(this.name, "judge API 応答の形式が不正です");
    }
    return { text, confidence: OpenRouterProvider.JUDGE_CONFIDENCE };
  }
}
