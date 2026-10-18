import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/** Re-exported for `scripts/`, which have no zod of their own. */
export { z };

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

export interface ImageInput {
  /** image/jpeg, image/png, image/gif or image/webp (see prepareImage for HEIC) */
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  base64: string;
}

export interface DocumentInput {
  mediaType: "application/pdf";
  base64: string;
}

export interface ExtractInput {
  system: string;
  user: string;
  model?: "fast" | "smart";
  maxTokens?: number;
}

export interface DraftInput {
  system: string;
  user: string;
  maxTokens?: number;
  /** Defaults to the drafting model; "fast" runs a simulated owner or a judge cheaply. */
  model?: "fast" | "smart";
}

export interface LLM {
  readonly name: string;
  classify(input: ClassifyInput): Promise<ClassifyResult>;
  draft(input: DraftInput): Promise<string>;
  /** Structured extraction; `model: "smart"` runs it on the drafting model (the onboarding call). */
  extract<T>(schema: z.ZodType<T>, input: ExtractInput): Promise<T>;
  /** Structured extraction over one or more images plus text. */
  extractFromImages<T>(
    schema: z.ZodType<T>,
    input: { system: string; user: string; images: ImageInput[] },
  ): Promise<T>;
  /** Structured extraction over a PDF (a lease) plus text. */
  extractFromDocument<T>(
    schema: z.ZodType<T>,
    input: { system: string; user: string; document: DocumentInput },
  ): Promise<T>;
}

const CLAUDE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * Turn attachment bytes into an image Claude accepts. HEIC/HEIF (every iPhone photo) is decoded to JPEG
 * with heif2jpeg (prebuilt binaries for macOS and Linux). Returns null for non-images.
 */
export async function prepareImage(bytes: Uint8Array, contentType: string): Promise<ImageInput | null> {
  const ct = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ct === "image/heic" || ct === "image/heif") {
    const { heifToJpeg } = await import("heif2jpeg");
    const jpeg = await heifToJpeg(Buffer.from(bytes), { quality: 80 });
    return { mediaType: "image/jpeg", base64: Buffer.from(jpeg).toString("base64") };
  }
  if (CLAUDE_IMAGE_TYPES.has(ct)) {
    return { mediaType: ct as ImageInput["mediaType"], base64: Buffer.from(bytes).toString("base64") };
  }
  return null;
}

/** Keyword-driven stand-in used in tests and when no API key is configured. */
export class FakeLLM implements LLM {
  readonly name = "fake";
  /** Tests set this to control what "vision" returns. */
  visionResult: unknown = null;
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
  async extractFromImages<T>(schema: z.ZodType<T>): Promise<T> {
    if (this.visionResult == null) throw new Error("FakeLLM.visionResult not set");
    return schema.parse(this.visionResult);
  }
  /** Tests set this to control what a document read returns. */
  documentResult: unknown = null;
  async extractFromDocument<T>(schema: z.ZodType<T>): Promise<T> {
    if (this.documentResult == null) throw new Error("FakeLLM.documentResult not set");
    return schema.parse(this.documentResult);
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

  async draft(input: DraftInput): Promise<string> {
    const res = await this.client.messages.create({
      model: input.model === "fast" ? this.fast : this.smart,
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

  async extract<T>(schema: z.ZodType<T>, input: ExtractInput): Promise<T> {
    const smart = input.model === "smart";
    const res = await this.client.messages.parse({
      model: smart ? this.smart : this.fast,
      max_tokens: input.maxTokens ?? (smart ? 4096 : 2048),
      output_config: { effort: smart ? "medium" : "low", format: zodOutputFormat(schema) },
      system: input.system,
      messages: [{ role: "user", content: input.user }],
    });
    if (res.parsed_output == null) throw new Error("extraction returned no parsable output");
    return res.parsed_output;
  }

  async extractFromImages<T>(
    schema: z.ZodType<T>,
    input: { system: string; user: string; images: ImageInput[] },
  ): Promise<T> {
    const content: Anthropic.ContentBlockParam[] = [
      ...input.images.map(
        (img): Anthropic.ImageBlockParam => ({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.base64 },
        }),
      ),
      { type: "text", text: input.user },
    ];
    const res = await this.client.messages.parse({
      model: this.smart,
      max_tokens: 2048,
      output_config: { effort: "low", format: zodOutputFormat(schema) },
      system: input.system,
      messages: [{ role: "user", content }],
    });
    if (res.parsed_output == null) throw new Error("image extraction returned no parsable output");
    return res.parsed_output;
  }

  async extractFromDocument<T>(
    schema: z.ZodType<T>,
    input: { system: string; user: string; document: DocumentInput },
  ): Promise<T> {
    const content: Anthropic.ContentBlockParam[] = [
      {
        type: "document",
        source: { type: "base64", media_type: input.document.mediaType, data: input.document.base64 },
      },
      { type: "text", text: input.user },
    ];
    const res = await this.client.messages.parse({
      model: this.smart,
      max_tokens: 4096,
      output_config: { effort: "low", format: zodOutputFormat(schema) },
      system: input.system,
      messages: [{ role: "user", content }],
    });
    if (res.parsed_output == null) throw new Error("document extraction returned no parsable output");
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
