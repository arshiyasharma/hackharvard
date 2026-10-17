/**
 * @elves/voice: what happens after a phone call. A Retell webhook becomes stored state (move fields, items, facts,
 * a transcript, a note per Elf) and a recap text, using the same tables a text message writes.
 */
import { createLogger, type Logger } from "@elves/shared";
import { type IngestDeps, type IngestResult, ingestCall } from "./ingest.ts";
import { RetellEvent, verifyRetellSignature } from "./retell.ts";

export * from "./ingest.ts";
export * from "./retell.ts";

export interface WebhookDeps extends IngestDeps {
  /** The Retell API key that has the webhook badge; it signs every delivery. */
  apiKey: string | null;
  /** Deliver the recap text to the owner (the service sends it as the Crew Lead). */
  sendRecap?: (moveId: string, text: string, callId: string) => Promise<void>;
  logger?: Logger;
}

/** Verify, parse and ingest one Retell delivery. Returns what the HTTP route should answer. */
export async function handleRetellWebhook(
  deps: WebhookDeps,
  rawBody: string,
  signature: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const log = deps.logger ?? createLogger("voice");
  if (!deps.apiKey) return { status: 503, body: { error: "RETELL_API_KEY is not set" } };
  if (!verifyRetellSignature(rawBody, signature, deps.apiKey))
    return { status: 401, body: { error: "bad signature" } };
  let evt: RetellEvent;
  try {
    evt = RetellEvent.parse(JSON.parse(rawBody));
  } catch (err) {
    return { status: 400, body: { error: "unreadable payload", detail: String(err).slice(0, 200) } };
  }
  let res: IngestResult;
  try {
    res = await ingestCall(deps, evt);
  } catch (err) {
    // 500 makes Retell retry (up to 3 times); ingest is idempotent on the call id.
    log.error("call ingest failed", { callId: evt.call.call_id, error: String(err) });
    return { status: 500, body: { error: "ingest failed" } };
  }
  if (res.status === "ingested" && res.recap && res.moveId && deps.sendRecap) {
    try {
      await deps.sendRecap(res.moveId, res.recap, evt.call.call_id);
    } catch (err) {
      log.warn("recap text failed; call data was saved", { callId: evt.call.call_id, error: String(err) });
    }
  }
  return { status: 200, body: { ok: true, status: res.status } };
}
