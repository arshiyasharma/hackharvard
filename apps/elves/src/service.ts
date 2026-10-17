import { allElves, type Elf, type ElfContext, route } from "@elves/elves";
import type { LLM } from "@elves/llm";
import type { InboundMessage, Transport } from "@elves/photon";
import { type Batch, Pipeline, sendKey } from "@elves/pipeline";
import { createLogger, type Logger, type Move, type Participant, type Store } from "@elves/shared";

export interface ServiceDeps {
  store: Store;
  transport: Transport;
  llm: LLM;
  elves?: Elf[];
  debounceMs: number;
  publicUrl: string | null;
  logger?: Logger;
  now?: () => Date;
}

export interface Service {
  pipeline: Pipeline;
  handleBatch: (batch: Batch, ctx: { signal: AbortSignal }) => Promise<void>;
  run: (signal: AbortSignal) => Promise<void>;
  stats: () => Record<string, unknown>;
}

export function createService(deps: ServiceDeps): Service {
  const log = deps.logger ?? createLogger("service");
  const elves = deps.elves ?? allElves;
  const now = deps.now ?? (() => new Date());
  const counters = {
    inbound: 0,
    replies: 0,
    reactions: 0,
    failures: 0,
    lastInboundAt: null as string | null,
    lastReplyAt: null as string | null,
  };

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

  async function handleBatch(batch: Batch, { signal }: { signal: AbortSignal }) {
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

    const decision = await route(
      batch,
      {
        store: deps.store,
        llm: deps.llm,
        elves,
        context: `Move ${move.id}; move-out ${move.moveOutAt ?? "unknown"}`,
      },
      { firstContact },
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
    if (signal.aborted) {
      log.info("batch cancelled before send; carried forward", { traceId });
      return;
    }

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

    let n = 0;
    for (const reply of result.replies) {
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
    for (const m of batch.messages) await deps.store.setThreadOwner(m.id, elf.name);
    try {
      await deps.transport.typing(last.spaceId, last.agentId, false);
    } catch {
      // ignore
    }
    log.info("batch handled", {
      traceId,
      elf: elf.name,
      via: decision.via,
      replies: result.replies.length,
      ms: Date.now() - t0,
    });
  }

  const pipeline = new Pipeline({ debounceMs: deps.debounceMs, handle: handleBatch, logger: log });

  async function run(signal: AbortSignal) {
    log.info("inbound loop started", {
      transport: deps.transport.name,
      llm: deps.llm.name,
      debounceMs: deps.debounceMs,
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

  return { pipeline, handleBatch, run, stats: () => ({ ...counters, pipeline: pipeline.stats }) };
}
