/**
 * @elves/voice: what happens after a phone call. A Retell webhook becomes stored state (move fields, items, facts,
 * a transcript, a note per Elf) and a recap text, using the same tables a text message writes.
 */

import { formatDate } from "@elves/elves";
import { createLogger, type Logger } from "@elves/shared";
import { type IngestDeps, type IngestResult, ingestCall } from "./ingest.ts";
import { RetellEvent, verifyRetellSignature } from "./retell.ts";

export * from "./ingest.ts";
export * from "./retell.ts";

export interface WebhookDeps extends IngestDeps {
  /** The Retell API key that has the webhook badge; it signs every delivery. */
  apiKey: string | null;
  /** Deliver the recap text to the owner (the service sends it as the Crew Lead). */
  sendRecap?: (moveId: string, text: string, callId: string) => Promise<boolean>;
  logger?: Logger;
}

/**
 * Retell has two different webhooks. The agent's webhook sends finished calls (`call_ended`, with a `call` object).
 * The phone number's *inbound* webhook fires as a call rings, carries only the numbers, and expects a reply of
 * `{ call_inbound: { dynamic_variables } }` (string values) that the agent prompt can use as {{variables}}.
 */
function inboundNumbers(body: unknown): { from: string | null } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if ("call" in b) return null;
  const inner = (b.call_inbound && typeof b.call_inbound === "object" ? b.call_inbound : b) as Record<
    string,
    unknown
  >;
  const looksInbound = b.event === "call_inbound" || "call_inbound" in b || "from_number" in inner;
  if (!looksInbound) return null;
  return { from: typeof inner.from_number === "string" ? inner.from_number : null };
}

/** What the voice agent may already know about this caller. Empty for strangers and for unsigned requests. */
async function knownAboutCaller(deps: WebhookDeps, from: string | null): Promise<Record<string, string>> {
  const move = from ? await deps.store.getMoveByOwnerHandle(from) : undefined;
  if (!move) return { known_caller: "no" };
  const items = (await deps.store.listItems(move.id)).map((i) => i.name);
  return {
    known_caller: "yes",
    known_move_out: move.moveOutAt ? formatDate(move.moveOutAt) : "not set",
    known_move_in: move.moveInAt ? formatDate(move.moveInAt) : "not set",
    known_from_address: move.fromAddress ?? "not set",
    known_to_address: move.toAddress ?? "not set",
    known_items: items.length ? items.join(", ") : "none yet",
  };
}

/** Verify, parse and ingest one Retell delivery. Returns what the HTTP route should answer. */
export async function handleRetellWebhook(
  deps: WebhookDeps,
  rawBody: string,
  signature: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const log = deps.logger ?? createLogger("voice");
  if (!deps.apiKey) return { status: 503, body: { error: "RETELL_API_KEY is not set" } };
  const signed = verifyRetellSignature(rawBody, signature, deps.apiKey);
  let json: unknown = null;
  try {
    json = JSON.parse(rawBody);
  } catch {}
  const inbound = inboundNumbers(json);
  if (inbound) {
    // A ringing call must never be refused: unsigned requests just get no variables (and learn nothing).
    const vars = signed ? await knownAboutCaller(deps, inbound.from) : {};
    return { status: 200, body: { call_inbound: { dynamic_variables: vars } } };
  }
  if (!signed) return { status: 401, body: { error: "bad signature" } };
  let evt: RetellEvent;
  try {
    evt = RetellEvent.parse(json);
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
    let sent = false;
    try {
      sent = await deps.sendRecap(res.moveId, res.recap, evt.call.call_id);
    } catch (err) {
      log.warn("recap text failed; call data was saved", { callId: evt.call.call_id, error: String(err) });
    }
    if (!sent)
      // Visible in /events and the events table, so a missing text is never a silent failure.
      await deps.store.appendEvent({
        moveId: res.moveId,
        type: "call.recap_failed",
        payload: { callId: evt.call.call_id },
        traceId: null,
      });
  }
  return { status: 200, body: { ok: true, status: res.status } };
}
