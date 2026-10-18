import { DEFAULT_WEIGHT_LB, ExtractedFacts, extractFactsHeuristic, formatDate } from "@elves/elves";
import type { LLM } from "@elves/llm";
import type { FactInput, MoveMemory } from "@elves/memory";
import { createLogger, type ElfName, type Logger, type Move, type Store } from "@elves/shared";
import type { RetellCall, RetellEvent } from "./retell.ts";

export interface IngestDeps {
  store: Store;
  llm: LLM;
  /** Null when conversational memory is off: the call is still applied to the move and items. */
  memory: MoveMemory | null;
  logger?: Logger;
  now?: () => Date;
}

export type IngestStatus = "ingested" | "duplicate" | "ignored" | "unknown_caller";

export interface IngestResult {
  status: IngestStatus;
  moveId?: string;
  /** The text the Crew Lead should send the owner after the call; the caller delivers it. */
  recap?: string;
  summary?: string;
}

/** Retell events that carry a finished call. `call_ended` arrives first; `call_analyzed` is a duplicate for us. */
const HANDLED = new Set(["call_ended", "call_analyzed"]);
const MIN_TRANSCRIPT_CHARS = 20;
const TRANSCRIPT_CLIP = 12_000;

const SYSTEM = (today: string) =>
  `Extract moving facts from a phone call between a moving-crew agent and the owner. Today is ${today}. ` +
  "Resolve relative dates to ISO dates. Only include what the owner said. Use null when unknown.";

/** Which end of the call is the owner: the caller on inbound calls, the callee on outbound ones. */
export function ownerNumber(call: RetellCall): string | null {
  return (call.direction === "outbound" ? call.to_number : call.from_number) ?? null;
}

/** The owner's side of the call as plain text (falls back to the whole transcript). */
function ownerWords(call: RetellCall): string {
  const lines = call.transcript_object?.filter((t) => t.role === "user").map((t) => t.content);
  return lines?.length ? lines.join("\n") : (call.transcript ?? "");
}

function minutes(call: RetellCall): number | null {
  if (call.start_timestamp == null || call.end_timestamp == null) return null;
  return Math.max(0, Math.round((call.end_timestamp - call.start_timestamp) / 60_000));
}

async function extract(deps: IngestDeps, call: RetellCall, now: Date): Promise<ExtractedFacts> {
  const heuristic = extractFactsHeuristic(ownerWords(call), now);
  if (deps.llm.name === "fake") return heuristic;
  try {
    const f = await deps.llm.extract(ExtractedFacts, {
      system: SYSTEM(now.toISOString().slice(0, 10)),
      user: call.transcript ?? ownerWords(call),
    });
    return {
      ...f,
      moveOutDate: f.moveOutDate ?? heuristic.moveOutDate,
      items: f.items.length ? f.items : heuristic.items,
    };
  } catch (err) {
    (deps.logger ?? createLogger("voice")).warn("call extraction failed; using heuristic", {
      error: String(err),
    });
    return heuristic;
  }
}

/**
 * Turn one finished call into stored state every Elf can read:
 *   move fields and items (the Store), durable facts and a transcript (memory), a short brief per Elf (notes),
 *   an event, and a recap text for the owner.
 * Idempotent on the Retell call id. It never opens a deal or books anything: listing, spending and booking stay
 * behind the owner's explicit yes by text.
 */
export async function ingestCall(deps: IngestDeps, evt: RetellEvent): Promise<IngestResult> {
  // Retell sends call_ended and call_analyzed within milliseconds of each other. The saved-event check below can't
  // see a call that is still being written, so a second delivery waits for the first instead of repeating it.
  const id = evt.call.call_id;
  const running = inflight.get(id);
  if (running) {
    const r = await running;
    return r.status === "ingested" ? { status: "duplicate", moveId: r.moveId } : r;
  }
  const work = ingestOnce(deps, evt);
  inflight.set(id, work);
  try {
    return await work;
  } finally {
    inflight.delete(id);
  }
}

const inflight = new Map<string, Promise<IngestResult>>();

async function ingestOnce(deps: IngestDeps, evt: RetellEvent): Promise<IngestResult> {
  const log = deps.logger ?? createLogger("voice");
  const call = evt.call;
  if (!HANDLED.has(evt.event)) return { status: "ignored" };
  const spoken = (call.transcript ?? ownerWords(call)).trim();
  if (spoken.length < MIN_TRANSCRIPT_CHARS) return { status: "ignored" };

  const number = ownerNumber(call);
  const move = number ? await deps.store.getMoveByOwnerHandle(number) : undefined;
  if (!move) {
    await deps.store.appendEvent({
      moveId: null,
      type: "call.unmatched",
      payload: { callId: call.call_id, number },
      traceId: null,
    });
    log.warn("call from a number with no move", { callId: call.call_id });
    return { status: "unknown_caller" };
  }

  const done = (await deps.store.listEvents(move.id)).some(
    (e) => e.type === "call.completed" && e.payload.callId === call.call_id,
  );
  if (done) return { status: "duplicate", moveId: move.id };

  const now = (deps.now ?? (() => new Date()))();
  const facts = await extract(deps, call, now);
  const callTag = `call:${call.call_id}`;
  const conflicts: string[] = [];
  const memFacts: Omit<FactInput, "moveId">[] = [];
  const known = {
    moveOut: move.moveOutAt,
    moveIn: move.moveInAt,
    from: move.fromAddress,
    to: move.toAddress,
  };

  // Fill empty move fields; a different value on the call never silently overwrites what the crew already has.
  const patch: Partial<Move> = {};
  const field = (
    label: string,
    said: string | null,
    have: string | null,
    set: (v: string) => void,
    show: (v: string) => string,
  ) => {
    if (!said) return;
    if (!have) {
      set(said);
      memFacts.push({
        subject: "move",
        kind: "commitment",
        text: `${label}: ${show(said)} (said on the phone call)`,
      });
    } else if (have !== said) {
      conflicts.push(`${label}: call said ${show(said)}, we have ${show(have)}`);
      memFacts.push({
        subject: "move",
        kind: "open_loop",
        text: `${label} is unclear: on the call the owner said ${show(said)} but we have ${show(have)}. Confirm which.`,
      });
    }
  };
  field("Move-out date", facts.moveOutDate, move.moveOutAt, (v) => (patch.moveOutAt = v), formatDate);
  field("Move-in date", facts.moveInDate, move.moveInAt, (v) => (patch.moveInAt = v), formatDate);
  field(
    "Moving from",
    facts.fromAddress,
    move.fromAddress,
    (v) => (patch.fromAddress = v),
    (v) => v,
  );
  field(
    "Moving to",
    facts.toAddress,
    move.toAddress,
    (v) => (patch.toAddress = v),
    (v) => v,
  );
  if (Object.keys(patch).length) await deps.store.updateMove(move.id, patch);

  // Items to sell or donate become rows (the Stuff Elf picks them up); items to keep or buy are facts only.
  const existing = await deps.store.listItems(move.id);
  const added: string[] = [];
  const keeping: string[] = [];
  const toBuy: string[] = [];
  for (const it of facts.items) {
    if (it.intent === "keep") {
      keeping.push(it.name);
      memFacts.push({
        subject: `item:${it.name}`,
        kind: "fact",
        text: `Owner is keeping the ${it.name}; it moves with them`,
      });
      continue;
    }
    if (it.intent === "buy") {
      toBuy.push(it.name);
      memFacts.push({
        subject: `item:${it.name}`,
        kind: "preference",
        text: `Owner wants to buy a ${it.name}`,
      });
      continue;
    }
    if (existing.some((e) => e.name.toLowerCase() === it.name.toLowerCase())) continue;
    await deps.store.upsertItem({
      moveId: move.id,
      name: it.name,
      category: it.category,
      weightLb: DEFAULT_WEIGHT_LB[it.category],
      listPriceCents: null,
      floorPriceCents: null,
      outcome: "listed",
    });
    added.push(it.name);
    memFacts.push({
      subject: `item:${it.name}`,
      kind: "fact",
      text:
        it.intent === "donate"
          ? `Owner wants to donate the ${it.name}`
          : `Owner wants to sell the ${it.name}`,
    });
  }
  for (const name of facts.roommates)
    memFacts.push({
      subject: `person:${name}`,
      kind: "person",
      text: `${name} is a roommate or is helping with the move`,
    });
  for (const ask of facts.asks)
    memFacts.push({ subject: "owner", kind: "open_loop", text: `Owner asked: ${ask}` });

  const moveOut = patch.moveOutAt ?? move.moveOutAt;
  const mins = minutes(call);
  const bits = [
    moveOut ? `move-out ${formatDate(moveOut)}` : null,
    added.length ? `${added.length} to sell or donate (${added.join(", ")})` : null,
    keeping.length ? `keeping ${keeping.join(", ")}` : null,
    facts.toAddress ? `moving to ${facts.toAddress}` : null,
  ].filter(Boolean);
  const summary =
    call.call_analysis?.call_summary?.trim() ||
    (bits.length ? `Heard: ${bits.join("; ")}.` : "No new move details.");

  // Memory: facts are per move, so every Elf's context sees them. The summary lands in the owner's own thread so
  // their next text has it; the full transcript gets a thread of its own so it never crowds the budget.
  const mem = deps.memory;
  if (mem) {
    try {
      const factsText = (f: Omit<FactInput, "moveId">) =>
        mem.addFact({ ...f, moveId: move.id, elf: "crew_lead", sourceMessageId: callTag });
      for (const f of memFacts) await factsText(f);
      await mem.ensureThread(move.ownerSpaceId, { moveId: move.id, role: "owner", handle: move.ownerHandle });
      await mem.remember({
        threadId: move.ownerSpaceId,
        moveId: move.id,
        role: "system",
        id: callTag,
        text: `[Phone call${mins != null ? `, ${mins} min` : ""}] ${summary}`,
        elf: "crew_lead",
        metadata: { callId: call.call_id },
      });
      await mem.ensureThread(callTag, {
        moveId: move.id,
        role: "owner",
        handle: move.ownerHandle,
        title: "Phone call",
      });
      await mem.remember({
        threadId: callTag,
        moveId: move.id,
        role: "system",
        id: `${callTag}:transcript`,
        text: spoken.slice(0, TRANSCRIPT_CLIP),
        metadata: { callId: call.call_id },
      });
      await writeBriefs(mem, move.id, call.call_id, now, summary, {
        moveOut,
        moveIn: patch.moveInAt ?? move.moveInAt,
        from: patch.fromAddress ?? known.from,
        to: patch.toAddress ?? known.to,
        selling: added,
        keeping,
        toBuy,
        roommates: facts.roommates,
        asks: facts.asks,
        conflicts,
      });
    } catch (err) {
      log.warn("saving call to memory failed; move and items were still updated", { error: String(err) });
    }
  }

  await deps.store.patchBoard(move.id, "crew_lead", {
    status: "working",
    currentTask: "Followed up on your phone call",
    lastUpdate: summary,
  });
  await deps.store.appendEvent({
    moveId: move.id,
    type: "call.completed",
    payload: {
      callId: call.call_id,
      number,
      minutes: mins,
      summary,
      itemsAdded: added,
      datesSet: { moveOut: patch.moveOutAt ?? null, moveIn: patch.moveInAt ?? null },
      conflicts,
    },
    traceId: null,
  });
  log.info("call ingested", {
    callId: call.call_id,
    moveId: move.id,
    items: added.length,
    conflicts: conflicts.length,
  });
  return { status: "ingested", moveId: move.id, summary, recap: recap(added, moveOut, conflicts) };
}

interface Brief {
  moveOut: string | null;
  moveIn: string | null;
  from: string | null;
  to: string | null;
  selling: string[];
  keeping: string[];
  toBuy: string[];
  roommates: string[];
  asks: string[];
  conflicts: string[];
}

const MONEY_WORDS = /\b(pay|paid|split|rent|deposit|venmo|zelle|cash|budget|owe|refund|price|\$)/i;
const HOME_WORDS =
  /\b(lease|sublet|landlord|apartment|room|place|housing|storage|hotel|notice|deposit|utilities|internet)\b/i;
const MOVE_WORDS = /\b(truck|u-haul|uhaul|movers?|boxes|packing|van|parking|permit|storage)\b/i;

/** Each Elf gets its own slice of the call as a note it reads on its next turn; the Crew Lead keeps the summary. */
async function writeBriefs(
  mem: MoveMemory,
  moveId: string,
  callId: string,
  now: Date,
  summary: string,
  b: Brief,
) {
  const base = { callId, at: now.toISOString() };
  const asks = (re: RegExp) => b.asks.filter((a) => re.test(a));
  const briefs: Partial<Record<ElfName, Record<string, unknown>>> = {
    crew_lead: { ...base, summary, conflicts: b.conflicts, asks: b.asks },
    stuff: { ...base, toSell: b.selling, keeping: b.keeping, toBuy: b.toBuy, moveOut: b.moveOut },
    home: { ...base, moveOut: b.moveOut, moveIn: b.moveIn, from: b.from, to: b.to, asks: asks(HOME_WORDS) },
    moveday: {
      ...base,
      moveOut: b.moveOut,
      moveIn: b.moveIn,
      from: b.from,
      to: b.to,
      keeping: b.keeping,
      roommates: b.roommates,
      asks: asks(MOVE_WORDS),
    },
    money: { ...base, roommates: b.roommates, asks: asks(MONEY_WORDS) },
  };
  for (const [elf, value] of Object.entries(briefs))
    await mem.setNote(moveId, elf as ElfName, "call_brief", value);
}

/** Two or three plain lines with at most one ask; the owner's yes still gates everything that spends or posts. */
function recap(added: string[], moveOut: string | null, conflicts: string[]): string {
  const got = [
    moveOut ? `move-out ${formatDate(moveOut)}` : null,
    added.length ? `${added.join(", ")} to sell` : null,
  ].filter(Boolean);
  const head = got.length
    ? `Thanks for the call. I noted ${got.join(" and ")}.`
    : "Thanks for the call. I've noted what you told me.";
  let ask: string;
  if (conflicts.length) ask = `One thing to confirm: ${conflicts[0]}. Which is right?`;
  else if (added.length)
    ask = `What's the lowest you'd take for the ${added[0]}? Send a photo too and I'll list it.`;
  else if (!moveOut) ask = "What date are you moving out?";
  else ask = "Text me anything else, or a photo of what you're selling.";
  return `${head}\n${ask}`;
}
