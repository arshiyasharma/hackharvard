import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Retell webhook payloads. Only the fields we read are named; everything else passes through untouched.
 * `call_ended` carries the call without `call_analysis`; `call_analyzed` adds it.
 */
export const RetellCall = z
  .object({
    call_id: z.string(),
    from_number: z.string().nullish(),
    to_number: z.string().nullish(),
    direction: z.string().nullish(),
    transcript: z.string().nullish(),
    transcript_object: z.array(z.object({ role: z.string(), content: z.string() }).passthrough()).nullish(),
    start_timestamp: z.number().nullish(),
    end_timestamp: z.number().nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
    retell_llm_dynamic_variables: z.record(z.string(), z.unknown()).nullish(),
    disconnection_reason: z.string().nullish(),
    call_analysis: z.object({ call_summary: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();
export type RetellCall = z.infer<typeof RetellCall>;

export const RetellEvent = z.object({ event: z.string(), call: RetellCall }).passthrough();
export type RetellEvent = z.infer<typeof RetellEvent>;

const SIGNATURE = /^v=(\d+),d=([0-9a-fA-F]+)$/;
const TOLERANCE_MS = 5 * 60_000;

/**
 * Retell signs `X-Retell-Signature: v={ms timestamp},d={hex}` where d = HMAC-SHA256(apiKey, rawBody + timestamp).
 * Verify against the raw body, never a re-serialized one. Timestamps more than 5 minutes off are rejected (replay).
 */
export function verifyRetellSignature(
  rawBody: string,
  header: string | null | undefined,
  apiKey: string,
  nowMs: number = Date.now(),
): boolean {
  const m = header ? SIGNATURE.exec(header.trim()) : null;
  if (!m) return false;
  const ts = Number(m[1]);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > TOLERANCE_MS) return false;
  const want = createHmac("sha256", apiKey)
    .update(rawBody + m[1])
    .digest();
  const got = Buffer.from(m[2]!, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Sign a payload the way Retell does. Used by tests and by `bun run` smoke scripts. */
export function signRetell(rawBody: string, apiKey: string, tsMs: number = Date.now()): string {
  const d = createHmac("sha256", apiKey)
    .update(rawBody + String(tsMs))
    .digest("hex");
  return `v=${tsMs},d=${d}`;
}
