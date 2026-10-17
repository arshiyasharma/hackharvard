import {
  allElves,
  batchText,
  type Elf,
  type ElfContext,
  type ElfOutbound,
  type ElfReply,
  EMPTY_CONVERSATION,
  route,
  spaceOwnerKey,
} from "@elves/elves";
import { attributeInbound, dealBoard, joinDeal, lastCallSweep, policyFor } from "@elves/engine";
import { FakeListings, type ListingSource } from "@elves/listings";
import type { LLM } from "@elves/llm";
import type { MoveMemory } from "@elves/memory";
import type { InboundMessage, Transport } from "@elves/photon";
import { type Batch, Pipeline, sendKey } from "@elves/pipeline";
import { createLogger, type ElfName, type Logger, type Move, type Participant, type Store } from "@elves/shared";

export interface ServiceDeps {
  store: Store;
  transport: Transport;
  llm: LLM;
  elves?: Elf[];
  /** Conversational memory (transcript, facts, summaries); null disables it. */
  memory?: MoveMemory | null;
  /** Housing search source for the Home Elf; defaults to fixtures. */
  listings?: ListingSource;
  debounceMs: number;
  publicUrl: string | null;
  logger?: Logger;
  now?: () => Date;
  /** How often Last Call runs (relists anything unsold 48h before move-out); 0 turns the timer off. */
  sweepMs?: number;
}

export interface Service {
  pipeline: Pipeline;
  handleBatch: (batch: Batch, ctx: { signal: AbortSignal; settle?: () => void }) => Promise<void>;
  run: (signal: AbortSignal) => Promise<void>;
  /** One Last Call pass now; returns how many texts went out. */
  sweep: () => Promise<number>;
  stats: () => Record<string, unknown>;
}

/** How often the typing indicator is refreshed while an Elf's deferred work (a search) runs. */
const TYPING_KEEPALIVE_MS = 20_000;

export function createService(deps: ServiceDeps): Service {
  const log = deps.logger ?? createLogger("service");
  const elves = deps.elves ?? allElves;
  const now = deps.now ?? (() => new Date());
  const listings = deps.listings ?? new FakeListings();
  const counters = {
    inbound: 0,
    replies: 0,
    outbound: 0,
    sweeps: 0,
    reactions: 0,
    failures: 0,
    lastInboundAt: null as string | null,
    lastReplyAt: null as string | null,
  };
  const mem = deps.memory ?? null;
  /** Memory must never block a reply: log and move on. */
  async function safeMem<T>(label: string, fn: (m: MoveMemory) => Promise<T>): Promise<T | undefined> {
    if (!mem) return undefined;
    try {
      return await fn(mem);
    } catch (err) {
      log.warn(`memory ${label} failed`, { error: String(err) });
      return undefined;
    }
  }

  async function resolveMove(
    msg: InboundMessage,
  ): Promise<{ move: Move; participant: Participant; firstContact: boolean }> {
    const existing = await deps.store.getParticipantBySpace(msg.spaceId);
    if (existing) {
      const move = await deps.store.getMove(existing.moveId);
      if (move) return { move, participant: existing, firstContact: false };
    }
    // A stranger quoting a listing's ref code joins that deal, even if they run a move of their own; a stranger
    // who is not an owner joins the one open deal on this number their text names ("is the couch available?").
    let move = await deps.store.getMoveByOwnerHandle(msg.senderHandle);
    const attributed =
      (await attributeInbound(deps.store, msg, { allowMatch: false })) ??
      (move ? null : await attributeInbound(deps.store, msg, { allowMatch: true }));
    if (attributed) {
      const { participant, party } = await joinDeal(deps.store, attributed.deal, {
        spaceId: msg.spaceId,
        handle: msg.senderHandle,
        platform: msg.platform,
        agentUserId: msg.agentId,
      });
      await deps.store.appendEvent({
        moveId: attributed.move.id,
        type: "deal.party_joined",
        payload: { dealId: attributed.deal.id, partyId: party.id, via: attributed.via, role: participant.role },
        traceId: null,
      });
      log.info("counterparty joined a deal", {
        moveId: attributed.move.id,
        dealId: attributed.deal.id,
        via: attributed.via,
        spaceId: msg.spaceId,
      });
      return { move: attributed.move, participant, firstContact: false };
    }
    // A known owner texting from a new space (e.g. SMS after iMessage) joins their move; otherwise a new move.
    const firstContact = !move;
    if (!move) {
      move = await deps.store.createMove({
        ownerHandle: msg.senderHandle,
        ownerSpaceId: msg.spaceId,
        platform: msg.platform,
      });
      await deps.store.appendEvent({
        moveId: move.id,
        type: "move.created",
        payload: { ownerHandle: msg.senderHandle, spaceId: msg.spaceId },
        traceId: null,
      });
      log.info("new move", { moveId: move.id, owner: msg.senderHandle, spaceId: msg.spaceId });
    }
    const participant = await deps.store.upsertParticipant({
      moveId: move.id,
      handle: msg.senderHandle,
      role: "owner",
      spaceId: msg.spaceId,
      platform: msg.platform,
      agentUserId: msg.agentId,
    });
    return { move, participant, firstContact };
  }

  function inboundText(m: InboundMessage): string {
    const parts: string[] = [];
    if (m.text) parts.push(m.text);
    for (const a of m.attachments) parts.push(a.mimeType?.startsWith("image/") ? "[photo]" : "[attachment]");
    if (m.reaction) parts.push(`[reaction ${m.reaction.emoji}]`);
    return parts.join(" ") || "[empty]";
  }

  async function runOnSent(reply: ElfReply, messageId: string) {
    if (!reply.onSent) return;
    try {
      await reply.onSent(messageId);
    } catch (err) {
      log.warn("onSent hook failed", { error: String(err) });
    }
  }

  /**
   * Send a text into another space of the move, as the pool number that space talks to, and remember it in that
   * space's transcript. Idempotent on `key`.
   */
  async function deliverTo(move: Move, elf: ElfName, note: ElfOutbound, key: string, traceId: string | null) {
    const target = await deps.store.getParticipantBySpace(note.spaceId);
    const senderId =
      target?.agentUserId ??
      (await deps.store.listParticipants(move.id)).find((p) => p.role === "owner" && p.agentUserId)?.agentUserId;
    if (!senderId) {
      log.warn("no sender for outbound text; skipped", { spaceId: note.spaceId, key });
      return;
    }
    try {
      const sent = await deps.transport.send(
        {
          spaceId: note.spaceId,
          senderId,
          text: note.text,
          parentMessageId: note.parentMessageId ?? undefined,
          format: note.format ?? "plain",
        },
        key,
      );
      await deps.store.recordSend(key, sent.id);
      await deps.store.setThreadOwner(sent.id, elf);
      await deps.store.setThreadOwner(spaceOwnerKey(note.spaceId), elf);
      await runOnSent(note, sent.id);
      counters.outbound++;
      await deps.store.appendEvent({
        moveId: move.id,
        type: "outbound.sent",
        payload: { elf, spaceId: note.spaceId, messageId: sent.id, text: note.text },
        traceId,
      });
      await safeMem("remember outbound", async (m) => {
        await m.ensureThread(note.spaceId, { moveId: move.id, role: target?.role ?? "owner", handle: target?.handle ?? null });
        await m.remember({
          threadId: note.spaceId,
          moveId: move.id,
          role: "assistant",
          id: sent.id,
          text: note.text,
          elf,
          metadata: { outbound: true, traceId },
        });
      });
    } catch (err) {
      counters.failures++;
      log.error("outbound send failed", { key, spaceId: note.spaceId, error: String(err) });
    }
  }

  /** Last Call: anything unsold 48h before move-out relists free; owner and interested parties hear it. */
  async function sweep(): Promise<number> {
    counters.sweeps++;
    const res = await lastCallSweep(deps.store, { now: now() });
    for (const ev of res.events)
      await deps.store.appendEvent({ moveId: ev.moveId, type: ev.type, payload: ev.payload, traceId: null });
    let sent = 0;
    const touched = new Set<string>();
    for (const m of res.messages) {
      const move = await deps.store.getMove(m.moveId);
      const deal = await deps.store.getDeal(m.dealId);
      if (!move || !deal) continue;
      const elfName = policyFor(deal.mode).elf;
      const spaceId =
        m.to === "owner"
          ? move.ownerSpaceId
          : (await deps.store.listDealParties(deal.id)).find((p) => p.id === m.partyId)?.spaceId;
      if (!spaceId) continue;
      // One Last Call text per deal and recipient, ever.
      const key = sendKey("lastcall", `${deal.id}:${m.partyId ?? "owner"}`);
      if (await deps.store.getSend(key)) continue;
      await deliverTo(
        move,
        elfName,
        { spaceId, text: m.text, parentMessageId: m.to === "owner" ? deal.ownerThreadId : null },
        key,
        null,
      );
      touched.add(`${move.id}:${elfName}`);
      sent++;
    }
    for (const t of touched) {
      const [moveId, elfName] = t.split(":") as [string, ElfName];
      const board = await dealBoard(deps.store, moveId, ["sell_item", "buy_item"]);
      await deps.store.patchBoard(moveId, elfName, {
        status: "working",
        currentTask: board ? `Deals: ${board}` : "Last Call",
        lastUpdate: "Last Call: unsold items are free now",
      });
    }
    return sent;
  }

  async function handleBatch(batch: Batch, { signal, settle }: { signal: AbortSignal; settle?: () => void }) {
    const last = batch.messages[batch.messages.length - 1];
    if (!last) return;
    const t0 = Date.now();
    const { move, participant, firstContact } = await resolveMove(last);
    const traceId = batch.traceId;
    log.info("batch", {
      traceId,
      moveId: move.id,
      spaceId: batch.spaceId,
      n: batch.messages.length,
      carried: batch.carried,
      firstContact,
    });

    // Acknowledge before any model call: reaction + typing + read receipt (best effort, never blocks).
    const ack = (async () => {
      try {
        await deps.transport.react(
          { spaceId: last.spaceId, senderId: last.agentId, messageId: last.id },
          "👍",
          sendKey("react", last.id),
        );
        counters.reactions++;
      } catch (err) {
        log.debug("reaction not sent", { error: String(err) });
      }
      try {
        await deps.transport.read(last.id, sendKey("read", last.id));
      } catch (err) {
        log.debug("read receipt not sent", { error: String(err) });
      }
      try {
        await deps.transport.typing(last.spaceId, last.agentId, true);
      } catch (err) {
        log.debug("typing not sent", { error: String(err) });
      }
    })();

    const threadId = last.spaceId;
    const text = batchText(batch);
    await safeMem("ensureThread", (m) =>
      m.ensureThread(threadId, { moveId: move.id, role: participant.role, handle: participant.handle }),
    );

    const decision = await route(
      batch,
      {
        store: deps.store,
        llm: deps.llm,
        elves,
        context: `Move ${move.id}; move-out ${move.moveOutAt ?? "unknown"}`,
      },
      { firstContact, moveId: move.id, role: participant.role },
    );
    const elf = elves.find((e) => e.name === decision.elf) ?? elves[0]!;
    await deps.store.appendEvent({
      moveId: move.id,
      type: "message.routed",
      payload: {
        elf: elf.name,
        via: decision.via,
        confidence: decision.confidence,
        messageIds: batch.messages.map((m) => m.id),
        text: batch.messages.map((m) => m.text).filter(Boolean),
      },
      traceId,
    });

    // What the Elf should know, before this batch is added to the transcript.
    const conversation =
      (await safeMem("context", (m) =>
        m.context({ threadId, moveId: move.id, elf: elf.name, role: participant.role, query: text }),
      )) ?? EMPTY_CONVERSATION;
    // The inbound messages go into the transcript while the Elf works (idempotent on message id).
    const remembered = safeMem("remember inbound", async (m) => {
      for (const msg of batch.messages) {
        await m.remember({
          threadId,
          moveId: move.id,
          role: "user",
          id: msg.id,
          text: inboundText(msg),
          elf: elf.name,
          createdAt: msg.receivedAt,
          metadata: { senderHandle: msg.senderHandle, attachments: msg.attachments.map((a) => a.id) },
        });
      }
    });

    const ctx: ElfContext = {
      store: deps.store,
      llm: deps.llm,
      move,
      participant,
      batch,
      traceId,
      log,
      signal,
      publicUrl: deps.publicUrl,
      firstContact,
      now,
      fetchAttachment: (id) => deps.transport.fetchAttachment(id),
      conversation,
      listings,
    };
    let result: Awaited<ReturnType<Elf["handle"]>>;
    try {
      result = await elf.handle(ctx);
    } catch (err) {
      counters.failures++;
      log.error("elf failed", { elf: elf.name, traceId, error: String(err) });
      result = {
        replies: [
          { text: "Got your message. Give me a second and I'll get back to you.", parentMessageId: last.id },
        ],
        boardPatch: { status: "blocked", lastUpdate: `Error: ${String(err).slice(0, 120)}` },
      };
    }
    await ack;
    await remembered;
    if (signal.aborted) {
      log.info("batch cancelled before send; carried forward", { traceId });
      return;
    }
    // Deferred work ahead (a search): from here on a newer text queues behind this batch instead of cancelling it.
    if (result.later) settle?.();

    if (result.movePatch && Object.keys(result.movePatch).length)
      await deps.store.updateMove(move.id, result.movePatch);
    if (result.boardPatch) await deps.store.patchBoard(move.id, elf.name, result.boardPatch);
    for (const ev of result.events ?? [])
      await deps.store.appendEvent({
        moveId: move.id,
        type: ev.type,
        payload: { ...ev.payload, elf: elf.name },
        traceId,
      });

    const sentTexts: string[] = [];
    /** Send replies with keys reply:<lastId>:<n> continuing from `startN`; returns the next n. */
    const sendReplies = async (replies: ElfReply[], startN: number): Promise<number> => {
      let n = startN;
      for (const reply of replies) {
        const key = sendKey("reply", last.id, n++);
        const prior = await deps.store.getSend(key);
        if (prior) {
          log.debug("send already recorded; skipping", { key });
          continue;
        }
        try {
          const sent = await deps.transport.send(
            {
              spaceId: last.spaceId,
              senderId: last.agentId,
              text: reply.text,
              parentMessageId: reply.parentMessageId ?? undefined,
              format: reply.format ?? "plain",
            },
            key,
          );
          await deps.store.recordSend(key, sent.id);
          await deps.store.setThreadOwner(sent.id, elf.name);
          await runOnSent(reply, sent.id);
          counters.replies++;
          counters.lastReplyAt = new Date().toISOString();
          sentTexts.push(reply.text);
          await deps.store.appendEvent({
            moveId: move.id,
            type: "reply.sent",
            payload: {
              elf: elf.name,
              messageId: sent.id,
              parentMessageId: reply.parentMessageId ?? null,
              text: reply.text,
            },
            traceId,
          });
          await safeMem("remember reply", (m) =>
            m.remember({
              threadId,
              moveId: move.id,
              role: "assistant",
              id: sent.id,
              text: reply.text,
              elf: elf.name,
              metadata: { parentMessageId: reply.parentMessageId ?? null, traceId },
            }),
          );
        } catch (err) {
          counters.failures++;
          log.error("send failed", { traceId, key, error: String(err) });
          await deps.store.appendEvent({
            moveId: move.id,
            type: "reply.failed",
            payload: { elf: elf.name, error: String(err) },
            traceId,
          });
        }
      }
      return n;
    };

    /** Texts for other spaces (a buyer's DM, the owner chat), keyed note:<lastId>:<n>. */
    const sendOutbound = async (notes: ElfOutbound[], startN: number): Promise<number> => {
      let k = startN;
      for (const note of notes) {
        const key = sendKey("note", last.id, k++);
        if (await deps.store.getSend(key)) continue;
        await deliverTo(move, elf.name, note, key, traceId);
      }
      return k;
    };

    let n = await sendReplies(result.replies, 0);
    let notes = await sendOutbound(result.outbound ?? [], 0);

    // Slow follow-up work (a housing search) runs after the ack is out.
    if (result.later) {
      const keepTyping = setInterval(
        () => void deps.transport.typing(last.spaceId, last.agentId, true).catch(() => {}),
        TYPING_KEEPALIVE_MS,
      );
      let more: Awaited<ReturnType<NonNullable<typeof result.later>>>;
      try {
        more = await result.later();
      } catch (err) {
        counters.failures++;
        log.error("deferred step failed", { elf: elf.name, traceId, error: String(err) });
        more = {
          replies: [
            {
              text: "That took longer than it should have and fell over. Give me another nudge and I'll retry.",
              parentMessageId: last.id,
            },
          ],
          boardPatch: { status: "blocked", lastUpdate: `Error: ${String(err).slice(0, 120)}` },
        };
      } finally {
        clearInterval(keepTyping);
      }
      if (more.boardPatch) await deps.store.patchBoard(move.id, elf.name, more.boardPatch);
      for (const ev of more.events ?? [])
        await deps.store.appendEvent({
          moveId: move.id,
          type: ev.type,
          payload: { ...ev.payload, elf: elf.name },
          traceId,
        });
      n = await sendReplies(more.replies, n);
      notes = await sendOutbound(more.outbound ?? [], notes);
    }

    for (const m of batch.messages) await deps.store.setThreadOwner(m.id, elf.name);
    // The shared pool has no real threads, so "the Elf that last spoke in this space" is what follow-ups use.
    await deps.store.setThreadOwner(spaceOwnerKey(last.spaceId), elf.name);
    try {
      await deps.transport.typing(last.spaceId, last.agentId, false);
    } catch {
      // ignore
    }
    // Learn from the exchange in the background: facts now, a summary once the thread is long.
    if (sentTexts.length) {
      mem?.afterTurn({
        threadId,
        moveId: move.id,
        elf: elf.name,
        role: participant.role,
        text,
        reply: sentTexts.join("\n"),
        sourceMessageId: last.id,
      });
    }
    log.info("batch handled", {
      traceId,
      elf: elf.name,
      via: decision.via,
      replies: n,
      outbound: notes,
      deferred: !!result.later,
      contextTokens: conversation.tokens,
      ms: Date.now() - t0,
    });
  }

  const pipeline = new Pipeline({ debounceMs: deps.debounceMs, handle: handleBatch, logger: log });

  async function run(signal: AbortSignal) {
    const sweepMs = deps.sweepMs ?? 10 * 60_000;
    if (sweepMs > 0) {
      const timer = setInterval(
        () => void sweep().catch((err) => log.error("last call sweep failed", { error: String(err) })),
        sweepMs,
      );
      signal.addEventListener("abort", () => clearInterval(timer));
    }
    log.info("inbound loop started", {
      transport: deps.transport.name,
      llm: deps.llm.name,
      debounceMs: deps.debounceMs,
      memory: mem?.kind ?? "off",
      listings: listings.name,
    });
    for await (const msg of deps.transport.inbound(signal)) {
      counters.inbound++;
      counters.lastInboundAt = new Date().toISOString();
      log.info("inbound", {
        id: msg.id,
        from: msg.senderHandle,
        to: msg.agentHandle,
        spaceId: msg.spaceId,
        text: msg.text?.slice(0, 120) ?? null,
        attachments: msg.attachments.length,
      });
      pipeline.enqueue(msg);
    }
  }

  return {
    pipeline,
    handleBatch,
    run,
    sweep,
    stats: () => ({
      ...counters,
      memory: mem?.stats() ?? { kind: "off" },
      listings: listings.name,
      pipeline: pipeline.stats,
    }),
  };
}
