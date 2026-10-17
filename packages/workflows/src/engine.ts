import type { MastraStorage } from "@mastra/core/storage";
import type { MoveMemory } from "@elves/memory";
import { createLogger, type Item, type Logger, type Move, newId, type Participant, type Store } from "@elves/shared";
import { applyEvent, fmtUsd, LAST_CALL_HOURS, lastCallPrice } from "./rules.ts";
import { proposeSlots, rulesFromFacts, type SlotRules } from "./slots.ts";
import {
  type Deal,
  type DealEvent,
  type Effects,
  emptyEffects,
  type EngineStore,
  isClaimed,
  isOpen,
  type LastCallRow,
  type LastCallStage,
  type OutboundText,
  type Transition,
} from "./types.ts";
import { createEngineMastra } from "./workflows.ts";

export interface EngineConfig {
  /** Move-out is a date; this is the hour (UTC) it is treated as happening. 16 = noon in Boston (EDT). */
  moveOutHourUtc: number;
  tz: string;
  hours: { drop: number; free: number; close: number };
}

export interface DealEngineOptions {
  store: Store;
  engineStore: EngineStore;
  storage: MastraStorage;
  memory?: MoveMemory | null;
  logger?: Logger;
  now?: () => Date;
  config?: Partial<EngineConfig>;
}

export interface BuyerMatch {
  move: Move;
  item: Item | null;
}

const BUY_INTENT =
  /\b(available|interested|still (have|got|up|there)|buy|offer|take it|price|how much|pick ?up|dollars|bucks)\b|\$\s?\d/i;
const APPROVE = /\b(yes|yep|yeah|sure|ok|okay|take it|fine|go ahead|accept|deal|sell it)\b/i;
const DECLINE = /\b(no|nope|hold|don'?t|not that low|too low|pass|decline)\b/i;
const NOSHOW = /\b(no[- ]?show|didn'?t show|never showed|never came|stood (me|us) up|not here|hasn'?t shown)\b/i;
const HANDOFF = /\b(handed off|hand-?off done|picked (it |them )?up|they (have|got|took) it|it'?s gone|sold it|gave it to them|done deal)\b/i;
const WITHDRAW = /\b(pull|withdraw|take down|delist|not selling|stop selling|cancel the (sale|listing))\b/i;
const OPTOUT = /\b(keep|hold|don'?t drop|no last call|skip last call|not free)\b/i;

const STAGE_NEXT: Record<LastCallStage, LastCallStage> = { drop: "free", free: "close", close: "done", done: "done" };

/**
 * The Deal Engine: Stuff Elf's selling brain. Pure policy (policy.ts) + durable runs (Mastra workflows) +
 * queryable rows (EngineStore). Every public method returns Effects for the service to send and record;
 * the engine itself never touches a transport.
 */
export class DealEngine {
  readonly mastra;
  readonly config: EngineConfig;
  private readonly store: Store;
  private readonly es: EngineStore;
  private readonly memory: MoveMemory | null;
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly locks = new Map<string, Promise<unknown>>();
  private sink: Effects | null = null;
  private readonly counters = { deals: 0, buyerTurns: 0, ownerTurns: 0, lastCallFires: 0, failures: 0 };

  constructor(opts: DealEngineOptions) {
    this.store = opts.store;
    this.es = opts.engineStore;
    this.memory = opts.memory ?? null;
    this.log = opts.logger ?? createLogger("engine");
    this.now = opts.now ?? (() => new Date());
    this.config = { moveOutHourUtc: 16, tz: "America/New_York", hours: { ...LAST_CALL_HOURS }, ...(opts.config ?? {}) };
    this.mastra = createEngineMastra(opts.storage, {
      dispatch: (id, ev) => this.dispatch(id, ev),
      fireLastCall: (moveId, stage) => this.fire(moveId, stage),
    });
  }

  get kind() {
    return this.es.kind;
  }

  // ---------- public API ----------

  /** One open deal per item. Called when the owner approves a listing; a buyer can also open one directly. */
  async startDeal(item: Item, buyer?: { handle: string; spaceId: string; agentId: string | null }): Promise<Deal> {
    return this.withLock(`item:${item.id}`, async () => {
      const existing = (await this.es.dealsForItem(item.id)).filter(isOpen);
      const open = existing.find((d) => !d.buyerSpaceId || d.buyerSpaceId === buyer?.spaceId);
      if (open && !buyer) return open;
      if (open && buyer && !open.buyerSpaceId) {
        const claimed = await this.es.saveDeal({ ...open, buyerHandle: buyer.handle, buyerSpaceId: buyer.spaceId, buyerAgentId: buyer.agentId, updatedAt: this.now().toISOString() });
        return claimed;
      }
      if (open) return open;
      const ts = this.now().toISOString();
      const id = newId("dl");
      const deal: Deal = {
        id,
        moveId: item.moveId,
        itemId: item.id,
        itemName: item.name,
        runId: id,
        buyerHandle: buyer?.handle ?? null,
        buyerSpaceId: buyer?.spaceId ?? null,
        buyerAgentId: buyer?.agentId ?? null,
        status: "listed",
        stage: "negotiating",
        listCents: item.listPriceCents ?? item.floorPriceCents ?? 0,
        floorCents: item.floorPriceCents,
        lastOfferCents: null,
        counterCents: null,
        counters: 0,
        agreedCents: null,
        offeredSlots: [],
        slotAt: null,
        reschedules: 0,
        nudges: 0,
        buyerConfirmed: false,
        ownerConfirmed: false,
        reliability: 0.7,
        lastBuyerAt: null,
        lastCallOptOut: false,
        lastCallStage: "none",
        createdAt: ts,
        updatedAt: ts,
      };
      await this.es.saveDeal(deal);
      const wf = this.mastra.getWorkflow("deal");
      const run = await wf.createRun({ runId: id });
      const res = await run.start({ inputData: { dealId: id, status: deal.status, stage: deal.stage } });
      if (res.status !== "suspended") this.log.warn("deal run did not suspend on start", { dealId: id, status: res.status });
      this.counters.deals++;
      return deal;
    });
  }

  /** Is this unknown sender a buyer, and for which move? Owners are matched by handle before this is called. */
  async identifyBuyer(msg: { senderHandle: string; text: string | null }, opts: { buyerPhone?: string | null } = {}): Promise<BuyerMatch | null> {
    const moves = await this.store.listMoves();
    const candidates: { move: Move; items: Item[] }[] = [];
    for (const move of moves) {
      const items = (await this.store.listItems(move.id)).filter((i) => i.listingApproved && i.outcome === "listed");
      if (items.length) candidates.push({ move, items });
    }
    if (!candidates.length) return null;
    const text = (msg.text ?? "").toLowerCase();
    for (const c of candidates) {
      const item = matchItem(text, c.items);
      if (item) return { move: c.move, item };
    }
    if (opts.buyerPhone && msg.senderHandle === opts.buyerPhone) {
      const c = candidates[candidates.length - 1]!;
      return { move: c.move, item: c.items.length === 1 ? c.items[0]! : null };
    }
    if (candidates.length === 1 && BUY_INTENT.test(text)) {
      const c = candidates[0]!;
      return { move: c.move, item: c.items.length === 1 ? c.items[0]! : null };
    }
    return null;
  }

  /** A text from a buyer's own space. */
  async handleBuyerMessage(input: { move: Move; participant: Participant; text: string; at?: string }): Promise<Effects> {
    this.counters.buyerTurns++;
    const { move, participant } = input;
    const text = input.text.trim();
    const buyer = { handle: participant.handle, spaceId: participant.spaceId, agentId: participant.agentUserId };
    let deal = await this.es.dealForBuyerSpace(participant.spaceId);
    if (deal && !isOpen(deal) && deal.status !== "waiting") deal = null;
    if (!deal) {
      const items = (await this.store.listItems(move.id)).filter((i) => i.listingApproved && i.outcome === "listed");
      const item = matchItem(text.toLowerCase(), items) ?? (items.length === 1 ? items[0]! : null);
      if (!item) {
        const eff = emptyEffects();
        const menu = items.map((i) => `${i.name} ${i.listPriceCents === 0 ? "(free)" : i.listPriceCents != null ? fmtUsd(i.listPriceCents) : ""}`.trim());
        eff.messages.push(this.toBuyer(buyer, items.length ? `Hi! This is the owner's moving crew. Up for grabs: ${menu.join(", ")}. Which one are you asking about?` : "Hi! This is the owner's moving crew. Nothing is listed right now, but I'll text you when something is."));
        return eff;
      }
      const claimed = (await this.es.dealsForItem(item.id)).find((d) => isClaimed(d) && d.buyerSpaceId !== participant.spaceId);
      if (claimed) {
        const waiting = await this.es.saveDeal(this.newDealRow(item, buyer, "waiting"));
        const eff = emptyEffects();
        eff.messages.push(this.toBuyer(buyer, `Someone's ahead of you on the ${item.name}. I'll text you right away if it frees up.`));
        eff.events.push({ type: "deal.waitlisted", payload: { dealId: waiting.id, itemId: item.id, buyer: buyer.handle } });
        return eff;
      }
      deal = await this.startDeal(item, buyer);
    }
    if (deal.status === "waiting") {
      const eff = emptyEffects();
      eff.messages.push(this.toBuyer(buyer, `You're still next in line for the ${deal.itemName}; I'll text you the moment it frees up.`));
      return eff;
    }
    return this.runEvent(deal, { kind: "buyer_text", text, at: input.at ?? this.now().toISOString() });
  }

  /** The owner's text, when it is about a deal: approvals, no-shows, hand-offs, withdrawals, Last Call opt-outs. Null otherwise. */
  async handleOwnerMessage(input: { move: Move; text: string }): Promise<Effects | null> {
    const deals = (await this.es.listDeals(input.move.id)).filter(isOpen);
    if (!deals.length) return null;
    const text = input.text.trim();
    const t = text.toLowerCase();
    const byName = (list: Deal[]) => list.find((d) => t.includes(d.itemName.toLowerCase())) ?? (list.length === 1 ? list[0]! : null);

    const awaiting = deals.filter((d) => d.status === "awaiting_owner");
    if (awaiting.length && (APPROVE.test(t) || DECLINE.test(t))) {
      const deal = byName(awaiting) ?? awaiting[0]!;
      this.counters.ownerTurns++;
      return this.runEvent(deal, { kind: "owner_decision", approved: APPROVE.test(t) && !DECLINE.test(t) });
    }
    if (NOSHOW.test(t)) {
      const deal = byName(deals.filter((d) => d.status === "scheduled" || d.status === "handed_off"));
      if (deal) {
        this.counters.ownerTurns++;
        return this.runEvent(deal, { kind: "owner_noshow" });
      }
    }
    if (HANDOFF.test(t)) {
      const deal = byName(deals.filter((d) => d.status === "scheduled" || d.status === "handed_off"));
      if (deal) {
        this.counters.ownerTurns++;
        return this.runEvent(deal, { kind: "owner_handoff" });
      }
    }
    if (WITHDRAW.test(t)) {
      const deal = deals.find((d) => t.includes(d.itemName.toLowerCase()));
      if (deal) {
        this.counters.ownerTurns++;
        const eff = await this.runEvent(deal, { kind: "owner_withdraw" });
        eff.messages.push(this.toOwnerText(await this.ownerTarget(input.move), `Pulled the ${deal.itemName}. It won't be offered to anyone else.`));
        return eff;
      }
    }
    if (OPTOUT.test(t) && /\b(last call|price|drop|free)\b/.test(t)) {
      const deal = deals.find((d) => t.includes(d.itemName.toLowerCase()));
      if (deal) {
        this.counters.ownerTurns++;
        const eff = await this.runEvent(deal, { kind: "owner_optout" });
        eff.messages.push(this.toOwnerText(await this.ownerTarget(input.move), `Got it: the ${deal.itemName} stays at ${fmtUsd(deal.listCents)} through Last Call.`));
        return eff;
      }
      // No conversation yet about that item: hold its price with a listing row flagged opt-out.
      const item = (await this.store.listItems(input.move.id)).find((i) => i.outcome === "listed" && t.includes(i.name.toLowerCase()));
      if (item) {
        this.counters.ownerTurns++;
        await this.es.saveDeal({ ...this.newDealRow(item, null, "listed"), runId: null, lastCallOptOut: true });
        const eff = emptyEffects();
        eff.messages.push(this.toOwnerText(await this.ownerTarget(input.move), `Got it: the ${item.name} stays at ${fmtUsd(item.listPriceCents ?? 0)} through Last Call.`));
        eff.events.push({ type: "lastcall.opt_out", payload: { itemId: item.id } });
        return eff;
      }
    }
    return null;
  }

  /** Hooks for events the Elves emit: an approved listing opens a deal; a move-out date arms Last Call. */
  async onEvent(move: Move, type: string, payload: Record<string, unknown>): Promise<Effects> {
    const eff = emptyEffects();
    try {
      if (type === "listing.approved" && typeof payload.itemId === "string") {
        const item = (await this.store.listItems(move.id)).find((i) => i.id === payload.itemId);
        if (item) {
          await this.startDeal(item);
          await this.ensureLastCall(move);
        }
      } else if (type === "move.date_captured" && payload.kind === "move_out") {
        await this.ensureLastCall(move);
      } else if (type === "item.floor_set" && typeof payload.itemId === "string") {
        for (const d of (await this.es.dealsForItem(payload.itemId)).filter((d) => d.status === "listed")) {
          await this.es.saveDeal({ ...d, listCents: Number(payload.listPriceCents ?? d.listCents), floorCents: Number(payload.floorPriceCents ?? d.floorCents) });
        }
      }
    } catch (err) {
      this.counters.failures++;
      this.log.warn("engine onEvent failed", { type, error: String(err) });
    }
    return eff;
  }

  /** Arm the Last Call timer for a move with a move-out date (idempotent). */
  async ensureLastCall(move: Move): Promise<LastCallRow | null> {
    if (!move.moveOutAt) return null;
    return this.withLock(`lastcall:${move.id}`, async () => {
      const existing = await this.es.getLastCall(move.id);
      if (existing) return existing;
      const runId = `lastcall:${move.id}`;
      const wf = this.mastra.getWorkflow("last_call");
      const run = await wf.createRun({ runId });
      await run.start({ inputData: { moveId: move.id } });
      return this.es.saveLastCall({ moveId: move.id, runId, stage: "drop", status: "waiting", fired: [], updatedAt: this.now().toISOString() });
    });
  }

  /** When a Last Call stage is due for a move, from the live move-out date (so a changed date just works). */
  dueAt(move: Move, stage: Exclude<LastCallStage, "done">): Date | null {
    if (!move.moveOutAt) return null;
    const [y, m, d] = move.moveOutAt.split("-").map(Number);
    const moveOut = Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1, this.config.moveOutHourUtc);
    return new Date(moveOut - this.config.hours[stage] * 3600_000);
  }

  /** Fire every Last Call stage that is due. Call every minute; returns effects per move. */
  async tick(now: Date = this.now()): Promise<{ moveId: string; stage: LastCallStage; effects: Effects }[]> {
    const out: { moveId: string; stage: LastCallStage; effects: Effects }[] = [];
    for (const row of await this.es.listWaitingLastCalls()) {
      const move = await this.store.getMove(row.moveId);
      if (!move?.moveOutAt) continue;
      let current = row;
      for (let guard = 0; guard < 3 && current.status === "waiting"; guard++) {
        const stage = current.stage as Exclude<LastCallStage, "done">;
        const due = this.dueAt(move, stage);
        if (!due || now.getTime() < due.getTime()) break;
        const fired = await this.advanceLastCall(move, now);
        if (!fired) break;
        out.push(fired);
        current = (await this.es.getLastCall(move.id)) ?? current;
      }
    }
    return out;
  }

  /** Demo and operator control: fire the next Last Call stage now, regardless of the clock. */
  async forceLastCall(move: Move): Promise<{ moveId: string; stage: LastCallStage; effects: Effects } | null> {
    if (!(await this.es.getLastCall(move.id))) await this.ensureLastCall(move);
    return this.advanceLastCall(move, this.now());
  }

  listDeals(moveId: string) {
    return this.es.listDeals(moveId);
  }
  lastCall(moveId: string) {
    return this.es.getLastCall(moveId);
  }
  stats() {
    return { kind: this.es.kind, ...this.counters };
  }

  // ---------- internals ----------

  private async advanceLastCall(move: Move, now: Date) {
    return this.withLock(`lastcall:${move.id}`, async () => {
      const row = await this.es.getLastCall(move.id);
      if (!row || row.status !== "waiting") return null;
      const stage = row.stage;
      const wf = this.mastra.getWorkflow("last_call");
      const state = await wf.getWorkflowRunById(row.runId);
      const effects = await this.collect(async () => {
        if (!state) {
          const run = await wf.createRun({ runId: row.runId });
          await run.start({ inputData: { moveId: move.id } });
        }
        const run = await wf.createRun({ runId: row.runId });
        const res = await run.resume({ resumeData: { now: now.toISOString() } });
        if (res.status === "failed") throw res.error;
      });
      const next = STAGE_NEXT[stage];
      await this.es.saveLastCall({ ...row, stage: next, status: next === "done" ? "done" : "waiting", fired: [...row.fired, stage], updatedAt: now.toISOString() });
      this.counters.lastCallFires++;
      return { moveId: move.id, stage, effects };
    });
  }

  /** The body of a Last Call stage, run inside the workflow step. */
  private async fire(moveId: string, stage: "drop" | "free" | "close"): Promise<void> {
    const move = await this.store.getMove(moveId);
    if (!move) return;
    const sink = this.sink ?? emptyEffects();
    const items = (await this.store.listItems(moveId)).filter((i) => i.outcome === "listed");
    const deals = await this.es.listDeals(moveId);
    const owner = await this.ownerTarget(move);
    const touched: string[] = [];
    const kept: string[] = [];
    for (const item of items) {
      const mine = deals.filter((d) => d.itemId === item.id);
      if (mine.some((d) => d.status === "scheduled" || d.status === "handed_off" || d.status === "paid")) continue;
      if (stage !== "close" && mine.some((d) => d.lastCallOptOut)) {
        kept.push(item.name);
        continue;
      }
      if (stage === "close") {
        await this.store.upsertItem({ id: item.id, moveId: item.moveId, name: item.name, category: item.category, outcome: "dumped" });
        touched.push(item.name);
        for (const d of mine.filter(isOpen)) await this.es.saveDeal({ ...d, status: "withdrawn", stage: "done" });
        continue;
      }
      const price = lastCallPrice(stage, item.listPriceCents, item.floorPriceCents);
      await this.store.upsertItem({ id: item.id, moveId: item.moveId, name: item.name, category: item.category, listPriceCents: price.listCents, floorPriceCents: price.floorCents });
      touched.push(price.listCents === 0 ? `${item.name} (free)` : `${item.name} ${fmtUsd(price.listCents)}`);
      for (const d of mine.filter((d) => isOpen(d) || d.status === "waiting")) {
        const t = applyEvent(d, { kind: "price_change", listCents: price.listCents, floorCents: price.floorCents, why: stage === "drop" ? "dropped" : "free" }, this.policyCtx(move, {}));
        await this.persist(t, move, sink);
      }
      if (!mine.some(isOpen)) {
        // nobody is talking about it: open a fresh listing deal at the new price so the next buyer gets it
        await this.es.saveDeal({ ...this.newDealRow({ ...item, listPriceCents: price.listCents, floorPriceCents: price.floorCents }, null, "listed"), runId: null });
      }
    }
    const keptNote = kept.length ? ` Holding price on ${kept.join(", ")} as you asked.` : "";
    if (stage === "drop") {
      sink.messages.push(this.toOwnerText(owner, touched.length ? `Last Call, 48 hours out: prices dropped to 60% of list. ${touched.join(", ")}.${keptNote} Reply "keep the <item>" to hold any price.` : `Last Call, 48 hours out: nothing left to drop.${keptNote}`));
      sink.board.push({ elf: "stuff", status: "working", currentTask: "Last Call: prices dropped", lastUpdate: touched.join(", ") || "nothing to drop" });
    } else if (stage === "free") {
      sink.messages.push(this.toOwnerText(owner, touched.length ? `Last Call, 24 hours out: ${touched.join(", ")} are now free; forward this to your building or Buy Nothing group: "Free today, text ${owner?.agentHandle ?? "this number"}: ${touched.map((t) => t.replace(" (free)", "")).join(", ")}". I'm booking a donation or 311 pickup for whatever's left.${keptNote}` : `Last Call, 24 hours out: everything is spoken for.${keptNote}`));
      if (touched.length) sink.events.push({ type: "pickup.requested", payload: { items: touched.map((t) => t.replace(" (free)", "")), kinds: ["donation", "311"] } });
      sink.board.push({ elf: "stuff", status: "working", currentTask: "Last Call: free + booking pickup", lastUpdate: touched.join(", ") || "all spoken for" });
    } else {
      const all = await this.store.listItems(moveId);
      const counts = { sold: 0, given: 0, donated: 0, dumped: 0 };
      for (const i of all) if (i.outcome !== "listed") counts[i.outcome]++;
      sink.messages.push(this.toOwnerText(owner, `Move-out day. Outcomes: ${counts.sold} sold, ${counts.given} given away, ${counts.donated} donated, ${counts.dumped} dumped${touched.length ? ` (${touched.join(", ")})` : ""}. Move Report is on the Crew Board.`));
      sink.events.push({ type: "move.report_ready", payload: { ...counts } });
      sink.board.push({ elf: "stuff", status: "done", currentTask: "Move Report ready", lastUpdate: `${counts.sold} sold, ${counts.given} given, ${counts.dumped} dumped` });
    }
    sink.events.push({ type: "lastcall.stage", payload: { stage, items: touched, kept } });
  }

  /** Apply one event to a deal through its workflow run, collecting the texts and events it produces. */
  private runEvent(deal: Deal, event: DealEvent): Promise<Effects> {
    return this.withLock(`deal:${deal.id}`, async () => {
      const wf = this.mastra.getWorkflow("deal");
      if (!deal.runId) {
        // a listing row created by Last Call without a run: give it one now
        const run = await wf.createRun({ runId: deal.id });
        await run.start({ inputData: { dealId: deal.id, status: deal.status, stage: deal.stage } });
        deal = await this.es.saveDeal({ ...deal, runId: deal.id });
      }
      const runId = deal.runId ?? deal.id;
      return this.collect(async () => {
        const state = await wf.getWorkflowRunById(runId);
        if (!state) {
          const run = await wf.createRun({ runId });
          await run.start({ inputData: { dealId: deal.id, status: deal.status, stage: deal.stage } });
        } else if (state.status !== "suspended") {
          // terminal run (relisted, withdrawn, paid): apply directly so a late text still gets an answer
          await this.dispatch(deal.id, event);
          return;
        }
        const run = await wf.createRun({ runId });
        const res = await run.resume({ resumeData: event });
        if (res.status === "failed") throw res.error;
      });
    });
  }

  /** Policy + persistence for one event; called by the workflow step (or directly for terminal runs). */
  private async dispatch(dealId: string, event: DealEvent): Promise<Deal> {
    const deal = await this.es.getDeal(dealId);
    if (!deal) throw new Error(`deal ${dealId} not found`);
    const move = await this.store.getMove(deal.moveId);
    if (!move) throw new Error(`move ${deal.moveId} not found`);
    const rules = await this.slotRules(deal.moveId);
    const t = applyEvent(deal, event, this.policyCtx(move, rules));
    const sink = this.sink ?? emptyEffects();
    await this.persist(t, move, sink);
    // a relist frees the item for the next buyer in line
    if (t.deal.status === "relisted" || t.deal.status === "withdrawn") await this.promoteNext(t.deal, move, sink, t.deal.status === "withdrawn");
    return t.deal;
  }

  private async persist(t: Transition, move: Move, sink: Effects) {
    await this.es.saveDeal(t.deal);
    if (t.itemPatch) {
      const item = (await this.store.listItems(move.id)).find((i) => i.id === t.deal.itemId);
      if (item) await this.store.upsertItem({ id: item.id, moveId: item.moveId, name: item.name, category: item.category, ...t.itemPatch });
    }
    const owner = t.replies.some((r) => r.to === "owner") ? await this.ownerTarget(move) : null;
    for (const r of t.replies) {
      if (r.to === "buyer") {
        if (t.deal.buyerSpaceId) sink.messages.push({ audience: "buyer", spaceId: t.deal.buyerSpaceId, senderId: t.deal.buyerAgentId ?? "", text: r.text });
      } else sink.messages.push(this.toOwnerText(owner, r.text));
    }
    for (const e of t.events) sink.events.push({ type: e.type, payload: { ...e.payload, dealId: t.deal.id, itemId: t.deal.itemId } });
    if (t.money) sink.events.push({ type: `escrow.${t.money}`, payload: { dealId: t.deal.id, itemId: t.deal.itemId, amountCents: t.deal.agreedCents, buyer: t.deal.buyerHandle } });
    if (t.deal.status === "paid") sink.board.push({ elf: "stuff", status: "working", currentTask: "Selling", lastUpdate: `${t.deal.itemName} sold for ${fmtUsd(t.deal.agreedCents ?? 0)}` });
    else if (t.deal.status === "scheduled") sink.board.push({ elf: "stuff", status: "working", currentTask: `Pickup booked: ${t.deal.itemName}`, lastUpdate: `${t.deal.offeredSlots.find((s) => s.start === t.deal.slotAt)?.label ?? t.deal.slotAt} with ${t.deal.buyerHandle ?? "buyer"}` });
    else if (t.deal.status === "awaiting_owner") sink.board.push({ elf: "stuff", status: "waiting", currentTask: `Need your call on the ${t.deal.itemName}`, lastUpdate: `Offer ${fmtUsd(t.deal.lastOfferCents ?? 0)} vs floor ${fmtUsd(t.deal.floorCents ?? 0)}` });
  }

  private async promoteNext(closed: Deal, move: Move, sink: Effects, withdrawn: boolean) {
    const waiting = (await this.es.dealsForItem(closed.itemId)).filter((d) => d.status === "waiting");
    for (const w of waiting) {
      if (withdrawn) {
        await this.es.saveDeal({ ...w, status: "withdrawn", stage: "done" });
        if (w.buyerSpaceId) sink.messages.push({ audience: "buyer", spaceId: w.buyerSpaceId, senderId: w.buyerAgentId ?? "", text: `Sorry, the ${w.itemName} is no longer available.` });
        continue;
      }
    }
    const next = waiting[0];
    if (!next || withdrawn) return;
    const item = (await this.store.listItems(move.id)).find((i) => i.id === closed.itemId);
    const promoted: Deal = { ...next, listCents: item?.listPriceCents ?? closed.listCents, floorCents: item?.floorPriceCents ?? closed.floorCents, runId: next.id };
    await this.es.saveDeal(promoted);
    const wf = this.mastra.getWorkflow("deal");
    const run = await wf.createRun({ runId: next.id });
    await run.start({ inputData: { dealId: next.id, status: "waiting", stage: "negotiating" } });
    const t = applyEvent(promoted, { kind: "promote" }, this.policyCtx(move, {}));
    await this.persist(t, move, sink);
  }

  private policyCtx(move: Move, rules: SlotRules) {
    return { now: this.now(), slots: () => proposeSlots({ now: this.now(), moveOutAt: move.moveOutAt, rules, tz: this.config.tz }) };
  }

  private async slotRules(moveId: string): Promise<SlotRules> {
    if (!this.memory) return {};
    try {
      const facts = await this.memory.recall(moveId, "pickup mornings evenings weekends weekdays time", 8);
      return rulesFromFacts(facts.map((f) => f.text));
    } catch {
      return {};
    }
  }

  private newDealRow(item: Item, buyer: { handle: string; spaceId: string; agentId: string | null } | null, status: Deal["status"]): Deal {
    const ts = this.now().toISOString();
    const id = newId("dl");
    return {
      id,
      moveId: item.moveId,
      itemId: item.id,
      itemName: item.name,
      runId: id,
      buyerHandle: buyer?.handle ?? null,
      buyerSpaceId: buyer?.spaceId ?? null,
      buyerAgentId: buyer?.agentId ?? null,
      status,
      stage: "negotiating",
      listCents: item.listPriceCents ?? item.floorPriceCents ?? 0,
      floorCents: item.floorPriceCents,
      lastOfferCents: null,
      counterCents: null,
      counters: 0,
      agreedCents: null,
      offeredSlots: [],
      slotAt: null,
      reschedules: 0,
      nudges: 0,
      buyerConfirmed: false,
      ownerConfirmed: false,
      reliability: 0.7,
      lastBuyerAt: null,
      lastCallOptOut: false,
      lastCallStage: "none",
      createdAt: ts,
      updatedAt: ts,
    };
  }

  private async ownerTarget(move: Move): Promise<{ spaceId: string; agentId: string | null; agentHandle: string | null } | null> {
    const owner = (await this.store.listParticipants(move.id)).find((p) => p.role === "owner" && p.spaceId === move.ownerSpaceId) ?? (await this.store.listParticipants(move.id)).find((p) => p.role === "owner");
    if (owner) return { spaceId: owner.spaceId, agentId: owner.agentUserId, agentHandle: null };
    return { spaceId: move.ownerSpaceId, agentId: null, agentHandle: null };
  }
  private toOwnerText(owner: { spaceId: string; agentId: string | null } | null, text: string): OutboundText {
    return { audience: "owner", spaceId: owner?.spaceId ?? "", senderId: owner?.agentId ?? "", text };
  }
  private toBuyer(buyer: { spaceId: string; agentId: string | null }, text: string): OutboundText {
    return { audience: "buyer", spaceId: buyer.spaceId, senderId: buyer.agentId ?? "", text };
  }

  /** Run `fn` with a fresh effects sink and return what it collected. */
  private async collect(fn: () => Promise<void>): Promise<Effects> {
    const prev = this.sink;
    const sink = emptyEffects();
    this.sink = sink;
    try {
      await fn();
    } catch (err) {
      this.counters.failures++;
      throw err;
    } finally {
      this.sink = prev;
    }
    return sink;
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(key, next);
    next.finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }).catch(() => {});
    return next;
  }
}

/** The item a text is about, by name or category word; null when ambiguous. */
export function matchItem(text: string, items: Item[]): Item | null {
  const t = text.toLowerCase();
  const byName = items.filter((i) => i.name.toLowerCase().split(/\s+/).some((w) => w.length > 2 && new RegExp(`\\b${escape(w)}(es|s)?\\b`).test(t)));
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    const exact = byName.find((i) => t.includes(i.name.toLowerCase()));
    return exact ?? byName[0]!;
  }
  const byCategory = items.filter((i) => new RegExp(`\\b${escape(i.category.replace("_", " ").split(" ")[0] ?? "")}(es|s)?\\b`).test(t));
  return byCategory.length === 1 ? byCategory[0]! : null;
}
function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
