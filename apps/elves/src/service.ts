import {
  allElves,
  batchText,
  type DealHooks,
  type Elf,
  type ElfContext,
  type ElfReply,
  EMPTY_CONVERSATION,
  noDealHooks,
  route,
  runLastCall,
  spaceOwnerKey,
} from "@elves/elves";
import { FakeListings, type ListingSource } from "@elves/listings";
import type { LLM } from "@elves/llm";
import type { MoveMemory } from "@elves/memory";
import type { InboundMessage, Transport } from "@elves/photon";
import { type Batch, Pipeline, sendKey } from "@elves/pipeline";
import {
  createLogger,
  type ElfName,
  type Logger,
  type Move,
  type Participant,
  type Store,
} from "@elves/shared";

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
  /** The Deal Engine's side of selling; defaults to no-op hooks until it is merged. */
  deals?: DealHooks;
  /** How often Last Call checks every move, in ms (default 60 s); 0 turns the timer off (tests). */
  lastCallMs?: number;
}

export interface Service {
  pipeline: Pipeline;
  handleBatch: (batch: Batch, ctx: { signal: AbortSignal; settle?: () => void }) => Promise<void>;
  run: (signal: AbortSignal) => Promise<void>;
  /** Advance Last Call on every move (or one) as of `at`; returns what changed per move. */
  tickLastCall: (opts?: {
    moveId?: string;
    at?: Date;
  }) => Promise<{ moveId: string; stage: string | null; sent: boolean }[]>;
  /** Text the owner of a move outside of a reply (Last Call, reminders). Idempotent on `key`. */
  notifyOwner: (move: Move, elf: ElfName, text: string, key: string) => Promise<boolean>;
  stats: () => Record<string, unknown>;
}

/** How often the typing indicator is refreshed while an Elf's deferred work (a search) runs. */
const TYPING_KEEPALIVE_MS = 20_000;

export function createService(deps: ServiceDeps): Service {
  const log = deps.logger ?? createLogger("service");
  const elves = deps.elves ?? allElves;
  const now = deps.now ?? (() => new Date());
  const listings = deps.listings ?? new FakeListings();
  const deals = deps.deals ?? noDealHooks;
  const counters = {
    inbound: 0,
    replies: 0,
    reactions: 0,
    failures: 0,
    lastInboundAt: null as string | null,
    lastReplyAt: null as string | null,
    lastCallTicks: 0,
    lastCallSends: 0,
    lastCallFailures: 0,
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
    // A known owner texting from a new space (e.g. SMS after iMessage) joins their move; otherwise a new move.
    let move = await deps.store.getMoveByOwnerHandle(msg.senderHandle);
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
      { firstContact, moveId: move.id },
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
      deals,
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

    let n = await sendReplies(result.replies, 0);

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
      deferred: !!result.later,
      contextTokens: conversation.tokens,
      ms: Date.now() - t0,
    });
  }

  async function notifyOwner(move: Move, elf: ElfName, text: string, key: string): Promise<boolean> {
    if (await deps.store.getSend(key)) return false;
    const people = await deps.store.listParticipants(move.id);
    const owner =
      people.find((p) => p.role === "owner" && p.spaceId === move.ownerSpaceId) ??
      people.find((p) => p.role === "owner");
    if (!owner?.agentUserId) {
      // Loud: without the agent id we cannot send on the shared pool, and the owner would never hear about it.
      log.error("cannot notify owner: no agent id on the owner participant", { moveId: move.id, key });
      await deps.store.appendEvent({
        moveId: move.id,
        type: "notify.failed",
        payload: { elf, key, reason: "no owner agent id" },
        traceId: null,
      });
      return false;
    }
    const sent = await deps.transport.send(
      { spaceId: owner.spaceId, senderId: owner.agentUserId, text, format: "plain" },
      key,
    );
    await deps.store.recordSend(key, sent.id);
    await deps.store.setThreadOwner(sent.id, elf);
    await deps.store.setThreadOwner(spaceOwnerKey(owner.spaceId), elf);
    await deps.store.appendEvent({
      moveId: move.id,
      type: "reply.sent",
      payload: { elf, messageId: sent.id, parentMessageId: null, text, proactive: true },
      traceId: null,
    });
    await safeMem("remember notify", (m) =>
      m.remember({
        threadId: owner.spaceId,
        moveId: move.id,
        role: "assistant",
        id: sent.id,
        text,
        elf,
        metadata: { key },
      }),
    );
    counters.replies++;
    counters.lastReplyAt = new Date().toISOString();
    return true;
  }

  async function tickLastCall(opts: { moveId?: string; at?: Date } = {}) {
    const at = opts.at ?? now();
    const moves = opts.moveId
      ? [await deps.store.getMove(opts.moveId)].filter((m): m is Move => !!m)
      : (await deps.store.listMoves()).filter((m) => m.moveOutAt);
    const out: { moveId: string; stage: string | null; sent: boolean }[] = [];
    counters.lastCallTicks++;
    for (const move of moves) {
      try {
        const run = await runLastCall(deps.store, deals, move, at);
        for (const ev of run.events)
          await deps.store.appendEvent({
            moveId: move.id,
            type: ev.type,
            payload: { ...ev.payload, elf: "stuff" },
            traceId: null,
          });
        let sent = false;
        if (run.stage && run.ownerText) {
          await deps.store.patchBoard(move.id, "stuff", {
            status: run.stage === "closed" ? "done" : "working",
            currentTask: "Last Call",
            lastUpdate: `Last Call: ${run.stage}`,
          });
          sent = await notifyOwner(
            move,
            "stuff",
            run.ownerText,
            `lastcall:${move.id}:${run.stage}:${at.toISOString().slice(0, 13)}`,
          );
          if (sent) counters.lastCallSends++;
        }
        out.push({ moveId: move.id, stage: run.stage, sent });
      } catch (err) {
        counters.lastCallFailures++;
        log.error("last call failed", { moveId: move.id, error: String(err) });
        out.push({ moveId: move.id, stage: null, sent: false });
      }
    }
    return out;
  }

  const pipeline = new Pipeline({ debounceMs: deps.debounceMs, handle: handleBatch, logger: log });

  async function run(signal: AbortSignal) {
    const every = deps.lastCallMs ?? 60_000;
    if (every > 0) {
      let busy = false;
      const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        tickLastCall()
          .catch((err) => log.error("last call tick crashed", { error: String(err) }))
          .finally(() => {
            busy = false;
          });
      }, every);
      signal.addEventListener("abort", () => clearInterval(timer), { once: true });
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
    tickLastCall,
    notifyOwner,
    stats: () => ({
      ...counters,
      memory: mem?.stats() ?? { kind: "off" },
      listings: listings.name,
      pipeline: pipeline.stats,
    }),
  };
}
