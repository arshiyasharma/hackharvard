import {
  ELF_EMOJI,
  allElves,
  batchText,
  type Elf,
  type ElfContext,
  type ElfOutbound,
  type ElfReply,
  EMPTY_CONVERSATION,
  isAddressedOutbound,
  moveinSweep,
  route,
  type SentInfo,
  spaceOwnerKey,
} from "@elves/elves";
import { codesIn, dealBoard, inquiryFor, isOpen, joinDeal, lastCallSweep, policyFor } from "@elves/engine";
import { FakeListings, type ListingSource } from "@elves/listings";
import type { LLM } from "@elves/llm";
import type { MoveMemory } from "@elves/memory";
import { type InboundMessage, PhotonApiError, type Transport } from "@elves/photon";
import { type Batch, Pipeline, sendKey } from "@elves/pipeline";
import {
  ELF_LABELS,
  type Deal,
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
  /** How often the sweeps run (Last Call relists, move-in week reminders); 0 turns the timer off. */
  sweepMs?: number;
}

export interface Service {
  pipeline: Pipeline;
  handleBatch: (batch: Batch, ctx: { signal: AbortSignal; settle?: () => void }) => Promise<void>;
  run: (signal: AbortSignal) => Promise<void>;
  /** One Last Call and move-in reminder pass now; returns how many texts went out. */
  sweep: () => Promise<number>;
  /** Text the owner as an Elf outside any inbound batch (a call recap). Once per `key`; false when skipped. */
  notifyOwner: (moveId: string, elf: ElfName, text: string, key: string) => Promise<boolean>;
  stats: () => Record<string, unknown>;
}

/** "📦 Stuff Elf": the first line of every text the crew sends, so the owner always knows who is talking. */
export function elfHeader(elf: ElfName): string {
  return `${ELF_EMOJI[elf]} ${ELF_LABELS[elf]}`;
}

/** The text under its Elf's header, with a blank line between; a text that already carries it is left alone. */
export function withHeader(elf: ElfName, text: string): string {
  const head = elfHeader(elf);
  return text.startsWith(`${head}\n`) ? text : `${head}\n\n${text}`;
}

/**
 * Split a text into pieces of at most `max` characters, at blank lines first, then at line breaks, then at
 * spaces, so a reply Photon refuses for its length still arrives whole and readable.
 */
export function chunkText(text: string, max = 900): string[] {
  const out: string[] = [];
  const pack = (units: string[], sep: string) => {
    let cur = "";
    for (const u of units) {
      const next = cur ? `${cur}${sep}${u}` : u;
      if (next.length <= max) cur = next;
      else {
        if (cur) out.push(cur);
        if (u.length <= max) cur = u;
        else {
          // one unit is itself too long: break it on the next smaller separator
          const smaller = sep === "\n\n" ? "\n" : sep === "\n" ? " " : null;
          if (smaller) pack(u.split(smaller), smaller);
          else for (let i = 0; i < u.length; i += max) out.push(u.slice(i, i + max));
          cur = "";
        }
      }
    }
    if (cur) out.push(cur);
  };
  pack(text.split("\n\n"), "\n\n");
  return out.filter((p) => p.trim().length);
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

  const LIVE_PARTY = ["talking", "agreed", "awaiting_owner", "scheduled", "waitlisted"];

  /**
   * On the shared pool every phone that texts in runs a move of its own, so a buyer is usually also an owner.
   * A phone is treated as the counterparty on another move's deal while it is inside that conversation: from the
   * text that quotes the deal's ref code until the deal closes. Returns null when this phone is just an owner.
   */
  async function elsewhere(
    existing: Participant,
    msg: InboundMessage,
  ): Promise<{ move: Move; participant: Participant } | null> {
    const as = async (deal: Deal) => {
      const move = await deps.store.getMove(deal.moveId);
      if (!move) return null;
      const role = policyFor(deal.mode).counterpartyRole;
      const { id: _id, createdAt: _createdAt, ...rest } = existing;
      const participant = await deps.store.upsertParticipant({ ...rest, moveId: deal.moveId, role });
      return { move, participant };
    };
    for (const code of codesIn(msg.text ?? "")) {
      const deal = await deps.store.getDealByCode(code);
      if (deal && isOpen(deal.state) && deal.moveId !== existing.moveId) return as(deal);
    }
    const parties = (await deps.store.listDealPartiesBySpace(msg.spaceId))
      .filter((p) => LIVE_PARTY.includes(p.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const p of parties) {
      const deal = await deps.store.getDeal(p.dealId);
      if (deal && isOpen(deal.state)) return existing.moveId === deal.moveId ? null : as(deal);
    }
    return null;
  }

  async function resolveMove(
    msg: InboundMessage,
  ): Promise<{ move: Move; participant: Participant; firstContact: boolean }> {
    let existing = await deps.store.getParticipantBySpace(msg.spaceId);
    if (existing) {
      // The pool number a phone talks to can change (re-assigned); outbound texts must come from the current one.
      if (msg.agentId && existing.agentUserId !== msg.agentId) {
        const { id: _id, createdAt: _createdAt, ...rest } = existing;
        existing = await deps.store.upsertParticipant({ ...rest, agentUserId: msg.agentId });
      }
      // An owner quoting another move's ref code (or still inside that deal) is that deal's buyer for this text.
      const away = await elsewhere(existing, msg);
      if (away) {
        log.info("owner acting as counterparty on another move", {
          spaceId: msg.spaceId,
          moveId: away.move.id,
        });
        return { ...away, firstContact: false };
      }
      // A counterparty whose deal has closed, and who runs a move of their own, is that move's owner again.
      if (existing.role !== "owner") {
        const live = (await deps.store.listDealPartiesBySpace(msg.spaceId)).some((p) =>
          LIVE_PARTY.includes(p.status),
        );
        const own = live ? undefined : await deps.store.getMoveByOwnerHandle(msg.senderHandle);
        if (own && own.id !== existing.moveId) {
          const { id: _id, createdAt: _createdAt, ...rest } = existing;
          existing = await deps.store.upsertParticipant({ ...rest, moveId: own.id, role: "owner" });
          return { move: own, participant: existing, firstContact: false };
        }
      }
      const move = await deps.store.getMove(existing.moveId);
      if (move) return { move, participant: existing, firstContact: false };
    }
    // A stranger quoting a listing's ref code joins that deal, even if they run a move of their own; a stranger
    // who is not an owner joins the one open deal on this number their text names ("is the couch available?").
    let move = await deps.store.getMoveByOwnerHandle(msg.senderHandle);
    const inquiry = await inquiryFor(deps.store, msg, { allowMatch: !move });
    if (inquiry?.kind === "ask") {
      // Several listings fit: record them as a buyer-in-waiting, and the Stuff Elf asks which one they mean.
      const participant = await deps.store.upsertParticipant({
        moveId: inquiry.move.id,
        handle: msg.senderHandle,
        role: policyFor(inquiry.options[0]!.mode).counterpartyRole,
        spaceId: msg.spaceId,
        platform: msg.platform,
        agentUserId: msg.agentId,
      });
      // Remember exactly which listings we are about to offer, so "2" means the second one they were shown.
      await deps.store.appendEvent({
        moveId: inquiry.move.id,
        type: "inquiry.asked",
        payload: { spaceId: msg.spaceId, dealIds: inquiry.options.map((d) => d.id) },
        traceId: null,
      });
      log.info("stranger asked about several listings", {
        moveId: inquiry.move.id,
        options: inquiry.options.length,
        spaceId: msg.spaceId,
      });
      return { move: inquiry.move, participant, firstContact: false };
    }
    const attributed = inquiry?.kind === "join" ? inquiry.attribution : null;
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
        payload: {
          dealId: attributed.deal.id,
          partyId: party.id,
          via: attributed.via,
          role: participant.role,
        },
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

  async function runOnSent(reply: ElfReply, messageId: string, info: SentInfo = { line: null }) {
    if (!reply.onSent) return;
    try {
      await reply.onSent(messageId, info);
    } catch (err) {
      log.warn("onSent hook failed", { error: String(err) });
    }
  }

  /**
   * Open the space for a handle-addressed note from the dedicated line and put that person on the deal as its
   * counterparty (a lister). Null when the project cannot text first; the note is then dropped and logged.
   */
  async function openFor(
    move: Move,
    note: Extract<ElfOutbound, { to: unknown }>,
    key: string,
    traceId: string | null,
  ): Promise<{ spaceId: string; senderId: string; line: string | null; target: Participant } | null> {
    try {
      const opened = await deps.transport.openSpace(note.to.handle, note.to.platform);
      const who = {
        spaceId: opened.spaceId,
        handle: note.to.handle,
        platform: note.to.platform,
        agentUserId: opened.senderId,
      };
      const deal = await deps.store.getDeal(note.dealId);
      let target: Participant;
      if (deal) {
        const { participant, party } = await joinDeal(deps.store, deal, who);
        target = participant;
        await deps.store.appendEvent({
          moveId: move.id,
          type: "deal.party_joined",
          payload: { dealId: deal.id, partyId: party.id, via: "outreach", role: participant.role },
          traceId,
        });
      } else {
        target = await deps.store.upsertParticipant({ moveId: move.id, role: "lister", ...who });
      }
      log.info("opened a space from the dedicated line", {
        moveId: move.id,
        spaceId: opened.spaceId,
        line: opened.senderHandle,
        dealId: note.dealId,
      });
      return { spaceId: opened.spaceId, senderId: opened.senderId, line: opened.senderHandle, target };
    } catch (err) {
      counters.failures++;
      log.error("could not open a space for outreach; note dropped", {
        key,
        handle: note.to.handle,
        error: String(err),
      });
      return null;
    }
  }

  /**
   * Send a text into another space of the move, as the pool number that space talks to (or, for a note addressed
   * to a handle, from the dedicated line into a space opened for it), and remember it in that space's transcript.
   * Idempotent on `key`.
   */
  async function deliverTo(move: Move, elf: ElfName, note: ElfOutbound, key: string, traceId: string | null) {
    let spaceId: string;
    let senderId: string | null | undefined;
    let line: string | null = null;
    let target: Participant | undefined;
    if (isAddressedOutbound(note)) {
      const opened = await openFor(move, note, key, traceId);
      if (!opened) return;
      ({ spaceId, senderId, line, target } = opened);
    } else {
      spaceId = note.spaceId;
      target = await deps.store.getParticipantBySpace(spaceId);
      senderId =
        target?.agentUserId ??
        (await deps.store.listParticipants(move.id)).find((p) => p.role === "owner" && p.agentUserId)
          ?.agentUserId;
    }
    if (!senderId) {
      log.warn("no sender for outbound text; skipped", { spaceId, key });
      return;
    }
    try {
      const sent = await deps.transport.send(
        {
          spaceId,
          senderId,
          text: withHeader(note.elf ?? elf, note.text.trim()),
          parentMessageId: note.parentMessageId ?? undefined,
          format: note.format ?? "plain",
        },
        key,
      );
      await deps.store.recordSend(key, sent.id);
      await deps.store.setThreadOwner(sent.id, elf);
      await deps.store.setThreadOwner(spaceOwnerKey(spaceId), elf);
      await runOnSent(note, sent.id, { line });
      counters.outbound++;
      await deps.store.appendEvent({
        moveId: move.id,
        type: "outbound.sent",
        payload: { elf, spaceId, messageId: sent.id, text: note.text, ...(line ? { line } : {}) },
        traceId,
      });
      await safeMem("remember outbound", async (m) => {
        await m.ensureThread(spaceId, {
          moveId: move.id,
          role: target?.role ?? "owner",
          handle: target?.handle ?? null,
        });
        await m.remember({
          threadId: spaceId,
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
      log.error("outbound send failed", { key, spaceId, error: String(err) });
    }
  }

  /** Move-in week: one text per checklist task as it comes due, into the owner's space from the Home Elf. */
  async function remindMovein(): Promise<number> {
    const { reminders } = await moveinSweep(deps.store, { now: now() });
    let sent = 0;
    const touched = new Map<string, string>();
    for (const r of reminders) {
      const move = await deps.store.getMove(r.moveId);
      if (!move) continue;
      const key = sendKey("movein", `${r.moveId}:${r.key}:${r.dueAt}`);
      if (await deps.store.getSend(key)) continue;
      await deliverTo(move, "home", { spaceId: move.ownerSpaceId, text: r.text }, key, null);
      await deps.store.appendEvent({
        moveId: move.id,
        type: "movein.reminded",
        payload: { key: r.key, dueAt: r.dueAt, elf: "home" },
        traceId: null,
      });
      touched.set(move.id, r.text.split(". ")[0] ?? r.text);
      sent++;
    }
    for (const [moveId, lastUpdate] of touched)
      await deps.store.patchBoard(moveId, "home", { status: "working", lastUpdate });
    return sent;
  }

  /** Last Call: unsold things get cheaper at 72h and 48h, then relist free; owner and interested parties hear each step. */
  async function sweep(): Promise<number> {
    counters.sweeps++;
    const reminded = await remindMovein().catch((err) => {
      log.error("move-in reminder sweep failed", { error: String(err) });
      return 0;
    });
    const res = await lastCallSweep(deps.store, { now: now() });
    for (const ev of res.events)
      await deps.store.appendEvent({ moveId: ev.moveId, type: ev.type, payload: ev.payload, traceId: null });
    let sent = reminded;
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
      // One text per Last Call stage, deal and recipient. A later stage (second cut, free, close) still sends.
      const key = sendKey("lastcall", `${m.kind}:${deal.lastCallStage}:${deal.id}:${m.partyId ?? "owner"}`);
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
        lastUpdate: res.messages.some((m) => m.kind === "last_call_close")
          ? "Last Call: closed what nobody claimed"
          : res.messages.some((m) => m.kind === "last_call")
            ? "Last Call: unsold items are free now"
            : "Last Call: prices dropped",
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

    // Acknowledge before any model call (best effort, never blocks): read receipt, then a 👍 on every text in the
    // batch, then typing. SMS has no tapbacks, and a tapback on a tapback is noise, so those are skipped. On the
    // shared iMessage pool Photon refuses reactions (409); the transport stops asking that space after the first.
    const ack = (async () => {
      try {
        await deps.transport.read(last.id, sendKey("read", last.id));
      } catch (err) {
        log.debug("read receipt not sent", { error: String(err) });
      }
      for (const m of batch.messages) {
        if (m.platform === "sms" || (m.reaction && !m.text && !m.attachments.length)) continue;
        try {
          await deps.transport.react(
            { spaceId: m.spaceId, senderId: m.agentId, messageId: m.id },
            "👍",
            sendKey("react", m.id),
          );
          counters.reactions++;
        } catch (err) {
          log.debug("reaction not sent", { error: String(err) });
          break;
        }
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
        const bare = reply.text.trim();
        if (!bare) {
          log.error("empty reply; nothing sent", { traceId, key, elf: elf.name });
          continue;
        }
        const text = withHeader(reply.elf ?? elf.name, bare);
        const outbound = (t: string, k: string) =>
          deps.transport.send(
            {
              spaceId: last.spaceId,
              senderId: last.agentId,
              text: t,
              parentMessageId: reply.parentMessageId ?? undefined,
              format: reply.format ?? "plain",
            },
            k,
          );
        try {
          let sent: { id: string };
          try {
            sent = await outbound(text, key);
          } catch (err) {
            // Photon refused the text itself (422): a long reply goes out in pieces, at blank lines.
            if (!(err instanceof PhotonApiError && err.status === 422 && text.length > 300)) throw err;
            log.warn("send refused; resending in pieces", {
              traceId,
              key,
              chars: text.length,
              body: err.body,
            });
            const parts = chunkText(text);
            let first: { id: string } | null = null;
            for (let i = 0; i < parts.length; i++) {
              const s = await outbound(parts[i] as string, `${key}:c${i}`);
              first ??= s;
            }
            sent = first as { id: string };
          }
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
          log.error("send failed", {
            traceId,
            key,
            error: String(err),
            body: err instanceof PhotonApiError ? err.body : undefined,
          });
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
        () => void sweep().catch((err) => log.error("sweep failed", { error: String(err) })),
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

  async function notifyOwner(moveId: string, elf: ElfName, text: string, key: string): Promise<boolean> {
    const move = await deps.store.getMove(moveId);
    if (!move) return false;
    // The owner may have several spaces (iMessage, SMS, a line they were re-assigned from). Newest first; the first
    // space that accepts the text wins, so one dead line never silences the recap.
    const spaces = (await deps.store.listParticipants(move.id))
      .filter((p) => p.role === "owner" && p.agentUserId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((p) => p.spaceId);
    if (!spaces.includes(move.ownerSpaceId)) spaces.push(move.ownerSpaceId);
    const keys = spaces.map((spaceId) => sendKey("notify", `${key}:${spaceId}`));
    for (const k of keys) if (await deps.store.getSend(k)) return false; // already delivered
    for (const [i, spaceId] of spaces.entries()) {
      await deliverTo(move, elf, { spaceId, text }, keys[i]!, null);
      if (await deps.store.getSend(keys[i]!)) return true;
      log.warn("recap not delivered to this space; trying the next", { moveId, spaceId });
    }
    return false;
  }

  return {
    pipeline,
    handleBatch,
    run,
    sweep,
    notifyOwner,
    stats: () => ({
      ...counters,
      memory: mem?.stats() ?? { kind: "off" },
      listings: listings.name,
      pipeline: pipeline.stats,
    }),
  };
}
