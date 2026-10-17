import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export interface ClassifyInput {
  text: string;
  context: string;
  options: { id: string; description: string }[];
}
export interface ClassifyResult {
  id: string;
  confidence: number;
  reason: string;
}

export interface LLM {
  readonly name: string;
  classify(input: ClassifyInput): Promise<ClassifyResult>;
  draft(input: { system: string; user: string; maxTokens?: number }): Promise<string>;
  extract<T>(schema: z.ZodType<T>, input: { system: string; user: string }): Promise<T>;
}

/** Keyword-driven stand-in used in tests and when no API key is configured. */
export class FakeLLM implements LLM {
  readonly name = "fake";
  constructor(private readonly keywords: Record<string, string[]> = {}) {}
  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    const t = input.text.toLowerCase();
    for (const opt of input.options) {
      const words = this.keywords[opt.id] ?? [];
      if (words.some((w) => t.includes(w))) return { id: opt.id, confidence: 0.6, reason: "keyword" };
    }
    return { id: input.options[0]?.id ?? "", confidence: 0.2, reason: "default" };
  }
  async draft(input: { system: string; user: string }): Promise<string> {
    return `(fake reply to: ${input.user.slice(0, 60)})`;
  }
  async extract<T>(schema: z.ZodType<T>): Promise<T> {
    return schema.parse({});
  }
}

export interface ClaudeLLMOptions {
  apiKey?: string;
  fastModel?: string;
  smartModel?: string;
  client?: Anthropic;
}

const ClassifySchema = z.object({
  id: z.string(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

/** Claude: a fast model for routing/extraction, a stronger model for drafting replies. */
export class ClaudeLLM implements LLM {
  readonly name = "claude";
  private readonly client: Anthropic;
  private readonly fast: string;
  private readonly smart: string;
  constructor(opts: ClaudeLLMOptions = {}) {
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.fast = opts.fastModel ?? "claude-haiku-5-5";
    this.smart = opts.smartModel ?? "claude-sonnet-5-5";
  }

  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    const list = input.options.map((o) => `- ${o.id}: ${o.description}`).join("\n");
    const res = await this.client.messages.parse({
      model: this.fast,
      max_tokens: 512,
      output_config: { effort: "low", format: zodOutputFormat(ClassifySchema) },
      system:
        "You route inbound text messages for a moving-crew assistant to exactly one specialist. " +
        "Pick the single best option id from the list. Prefer the option whose job the message is clearly about; " +
        "use crew_lead for greetings, general questions, dates/addresses, or anything ambiguous.",
      messages: [
        {
          role: "user",
          content: `Context:\n${input.context}\n\nOptions:\n${list}\n\nMessage:\n"""${input.text}"""`,
        },
      ],
    });
    const parsed = res.parsed_output;
    if (!parsed || !input.options.some((o) => o.id === parsed.id)) {
      return { id: input.options[0]?.id ?? "", confidence: 0.3, reason: "unparsed" };
    }
    return parsed;
  }

  async draft(input: { system: string; user: string; maxTokens?: number }): Promise<string> {
    const res = await this.client.messages.create({
      model: this.smart,
      max_tokens: input.maxTokens ?? 1024,
      output_config: { effort: "low" },
      system: input.system,
      messages: [{ role: "user", content: input.user }],
    });
    if (res.stop_reason === "refusal") throw new Error("model refused");
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  async extract<T>(schema: z.ZodType<T>, input: { system: string; user: string }): Promise<T> {
    const res = await this.client.messages.parse({
      model: this.fast,
      max_tokens: 2048,
      output_config: { effort: "low", format: zodOutputFormat(schema) },
      system: input.system,
      messages: [{ role: "user", content: input.user }],
    });
    if (res.parsed_output == null) throw new Error("extraction returned no parsable output");
    return res.parsed_output;
  }
}

export function createLLM(env: NodeJS.ProcessEnv = process.env): LLM {
  const forceFake = env.ELVES_LLM === "fake" || env.ELVES_LLM_FAKE === "1" || env.ELVES_LLM_FAKE === "true";
  if (forceFake || !env.ANTHROPIC_API_KEY) return new FakeLLM();
  return new ClaudeLLM({
    apiKey: env.ANTHROPIC_API_KEY,
    fastModel: env.ANTHROPIC_MODEL_FAST ?? env.ELVES_MODEL_FAST,
    smartModel: env.ANTHROPIC_MODEL_SMART ?? env.ELVES_MODEL_SMART,
  });
}
