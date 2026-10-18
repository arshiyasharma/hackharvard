/**
 * Move Plans, wired to the Ledger and Nessie (decisions #53–#56).
 *
 * draft: run the simulator on the move's listed items and today's projection, keep the drafts locally.
 * choose: the owner's pick (that's their yes; nothing moves). Cancels the previous plan's Nessie records, then
 *   writes the new plan as pending, future-dated Nessie records: each likely sale is a pending deposit into the
 *   Moving Fund, and the truck and movers are pending withdrawals on the owner's account.
 * sweep: settle plan records as items sell or leave, and nudge the owner once per item that falls behind.
 */
import { fmtDate, fmtUsd } from "./amounts.ts";
import { tagged } from "./books.ts";
import type { PlanLine, PlanState } from "./ledger.ts";
import {
  ASSUMPTIONS,
  type DraftResult,
  draftPlans,
  type ItemAction,
  type Plan,
  type PlanChoice,
  type PlanInput,
  type PlanItem,
  type PlanLabel,
  pct,
  rescorePlan,
} from "./plans.ts";
import { netPhrase, projectMove } from "./projection.ts";
import type { MoneyService, OpResult } from "./service.ts";
import type { MoneyItem, MoneyMove, MoneyPoll } from "./types.ts";

let draftSeq = 0;

/** A nudge goes out when a plan's chance under budget drops by at least this much. */
export const DRIFT_POINTS = 0.1;

export interface PlanOp extends OpResult {
  poll?: MoneyPoll;
  /** Set when a reply should carry the plans picture. */
  showPlans?: boolean;
}

function op(): PlanOp {
  return { lines: [], events: [], outbound: [] };
}

export function toPlanItems(items: MoneyItem[]): PlanItem[] {
  return items
    .filter((it) => it.outcome === "listed")
    .map((it) => ({
      id: it.id,
      name: it.name,
      category: it.category,
      weightLb: it.weightLb,
      listCents: it.listPriceCents ?? 0,
      floorCents: it.floorPriceCents,
      keep: it.keep,
    }));
}

export function moveOutDate(move: MoneyMove): string | null {
  return move.moveOutAt ? move.moveOutAt.slice(0, 10) : null;
}

/** One plan in one line: "A · best odds · $300 · 56% under $300". */
export function planLine(p: Plan, budgetCents: number): string {
  return `${p.label} · ${p.name} · ${netPhrase(p.stats.p50Cents)} · ${pct(p.stats.chanceUnderBudget)} under ${fmtUsd(budgetCents)}`;
}

export function planPoll(state: PlanState): MoneyPoll {
  return {
    question: `Which plan? (under ${fmtUsd(state.budgetCents)})`,
    options: [
      ...state.drafts.map((p) => ({
        id: `money:plan:${state.draftKey}:${p.label}`,
        text: `Plan ${p.label}`,
      })),
      { id: `money:plan:${state.draftKey}:none`, text: "Not now" },
    ],
    selectionMode: "single",
  };
}

export const PLAN_POLL_ID = /^money:plan:([A-Za-z0-9]+):(A|B|C|none)$/;

/** What to do with each item, in a few words: "sell the couch at $120 (drops Oct 26)". */
function choiceWords(p: Plan): string[] {
  const say: Record<ItemAction, (c: PlanChoice) => string> = {
    sell: (c) => `${c.name} ${fmtUsd(c.askCents)}`,
    sell_early: (c) => `${c.name} down to ${fmtUsd(c.askCents)} now`,
    donate: (c) => `donate the ${c.name}`,
    haul: (c) => `haul the ${c.name}`,
  };
  return p.choices.map((c) => say[c.action](c));
}

export class PlanService {
  constructor(private readonly money: MoneyService) {}

  private get store() {
    return this.money.store;
  }

  /** The simulator's input for this move today: listed items plus the live projection from Nessie. */
  private async input(
    move: MoneyMove,
    items: PlanItem[],
    budgetCents: number,
    out: string,
  ): Promise<PlanInput> {
    const [books, entries, people] = await Promise.all([
      this.money.books(move),
      this.store.listEntries(move.id),
      this.store.listPeople(move.id),
    ]);
    const names = new Map(people.map((p) => [p.id, p.name]));
    const pr = projectMove({ books, entries, names, now: this.money.clock() });
    return {
      moveId: move.id,
      items,
      moveOutDate: out,
      budgetCents,
      netNowCents: pr.netNowCents,
      expected: pr.expected.map((e) => ({ date: e.date, cents: e.cents })),
      now: this.money.clock(),
    };
  }

  private async record(move: MoneyMove, state: PlanState): Promise<PlanState> {
    // One real net-cost point per day, for the actual line on the plan's path chart.
    const pr = await this.input(move, [], state.budgetCents, state.moveOutDate);
    const today = this.money.today();
    state.history = [
      ...state.history.filter((h) => h.date !== today),
      { date: today, netCents: pr.netNowCents },
    ];
    await this.store.setPlans(move.id, state);
    return state;
  }

  async draft(move: MoneyMove, items: MoneyItem[] | null, budgetCents: number): Promise<PlanOp> {
    const r = op();
    const out = moveOutDate(move);
    if (!items) {
      r.lines.push("I can't see your items yet, so I can't draft plans.");
      r.events.push({ type: "plan.error", payload: { reason: "no_items_source" } });
      return r;
    }
    if (!out) {
      r.lines.push("I need your move-out date to draft plans. When do you move out?");
      r.events.push({ type: "plan.error", payload: { reason: "no_move_out" } });
      return r;
    }
    const res: DraftResult = draftPlans(await this.input(move, toPlanItems(items), budgetCents, out));
    if (!res.ok) {
      r.lines.push(`Couldn't draft plans: ${res.reason}.`);
      r.events.push({ type: "plan.error", payload: { reason: res.reason } });
      return r;
    }
    const prev = await this.store.getPlans(move.id);
    const state: PlanState = {
      budgetCents,
      moveOutDate: out,
      // Time plus a counter: two drafts in the same millisecond still get different keys.
      draftKey: `${this.money.clock().getTime().toString(36)}${(++draftSeq).toString(36)}`,
      drafts: res.plans,
      chosen: prev?.chosen ?? null,
      chosenLabel: prev?.chosenLabel ?? null,
      chosenAt: prev?.chosenAt ?? null,
      chosenPrefix: prev?.chosenPrefix ?? null,
      lines: prev?.lines ?? [],
      nudged: prev?.nudged ?? {},
      history: prev?.history ?? [],
    };
    await this.record(move, state);
    r.lines.push(...res.plans.map((p) => planLine(p, budgetCents)));
    if (res.skipped.length) r.lines.push(`Skipped (no price yet): ${res.skipped.join(", ")}.`);
    r.poll = planPoll(state);
    r.showPlans = true;
    r.events.push({
      type: "plan.drafted",
      payload: {
        budgetCents,
        plans: res.plans.map((p) => ({
          label: p.label,
          name: p.name,
          p50Cents: p.stats.p50Cents,
          chance: p.stats.chanceUnderBudget,
        })),
      },
    });
    return r;
  }

  /** The owner picks a plan by label (a typed "go with B" or a poll tap). draftKey guards stale poll taps. */
  async choose(
    move: MoneyMove,
    items: MoneyItem[] | null,
    label: PlanLabel,
    draftKey?: string,
  ): Promise<PlanOp> {
    const r = op();
    const state = await this.store.getPlans(move.id);
    if (!state?.drafts.length) {
      r.lines.push(`I haven't drafted plans yet. Text "plan my move under $400" (your budget) and I will.`);
      return r;
    }
    if (draftKey && draftKey !== state.draftKey) {
      r.lines.push('Those plans are out of date. Want fresh ones? Text "plan my move" again.');
      r.events.push({ type: "plan.stale_vote", payload: { draftKey } });
      return r;
    }
    const draft = state.drafts.find((p) => p.label === label);
    if (!draft) {
      r.lines.push(`There's no plan ${label}. Pick ${state.drafts.map((p) => p.label).join(", ")}.`);
      return r;
    }
    // Re-score against today, so the confirmation quotes current numbers.
    const plan = items
      ? rescorePlan(await this.input(move, toPlanItems(items), state.budgetCents, state.moveOutDate), draft)
      : draft;
    const switching = state.chosen !== null;

    // 1. Cancel the previous plan's records that are still pending.
    for (const l of state.lines) {
      if (l.status !== "pending") continue;
      await this.money.rails.settle(l.kind, l.recordId, "cancelled");
      l.status = "cancelled";
    }
    // Saved now, so a Nessie failure below never leaves cancelled records marked pending.
    await this.store.setPlans(move.id, state);

    // 2. Write the new plan to Nessie as pending, future-dated records.
    const owner = await this.money.owner(move);
    const ownerAcct = await this.money.account(owner);
    const fund = await this.money.fundAccount(move);
    const prefix = `p${state.draftKey}${label}`;
    const lines: PlanLine[] = [];
    let n = 0;
    for (const c of plan.choices) {
      if (!c.likelySaleDate || c.likelySaleCents <= 0) continue;
      const lineId = `${prefix}_${++n}`;
      const what = `Plan ${label}: ${c.name} sale (expected)`;
      const res = await this.money.rails.moveMoney({
        fromAccountId: null,
        toAccountId: fund,
        amountCents: c.likelySaleCents,
        description: tagged(what, "plan_in", lineId),
        date: c.likelySaleDate,
        status: "pending",
      });
      if (res.depositId)
        lines.push({
          lineId,
          kind: "deposit",
          recordId: res.depositId,
          itemId: c.itemId,
          label: what,
          cents: c.likelySaleCents,
          date: c.likelySaleDate,
          status: "pending",
        });
    }
    const costs = [
      { what: `Plan ${label}: ${plan.truck.size} truck (estimate)`, cents: plan.truck.cents },
      ...(plan.movers ? [{ what: `Plan ${label}: movers (estimate)`, cents: ASSUMPTIONS.moversCents }] : []),
    ];
    for (const cost of costs) {
      const lineId = `${prefix}_${++n}`;
      const res = await this.money.rails.moveMoney({
        fromAccountId: ownerAcct,
        toAccountId: null,
        amountCents: cost.cents,
        description: tagged(cost.what, "plan_out", lineId),
        date: state.moveOutDate,
        status: "pending",
      });
      if (res.withdrawalId)
        lines.push({
          lineId,
          kind: "withdrawal",
          recordId: res.withdrawalId,
          itemId: null,
          label: cost.what,
          cents: cost.cents,
          date: state.moveOutDate,
          status: "pending",
        });
    }

    const next: PlanState = {
      ...state,
      chosen: plan,
      chosenLabel: label,
      chosenAt: this.money.clock().toISOString(),
      chosenPrefix: prefix,
      lines: [...state.lines, ...lines],
      nudged: {},
    };
    await this.record(move, next);
    r.lines.push(
      `${switching ? "Switched to" : "On"} plan ${label}: ${netPhrase(plan.stats.p50Cents)}, ${pct(plan.stats.chanceUnderBudget)} under ${fmtUsd(state.budgetCents)}.`,
    );
    r.lines.push(
      `${choiceWords(plan).join(", ")}; ${plan.truck.size} truck${plan.movers ? " + movers" : ""}.`,
    );
    r.lines.push(`Written to Nessie as ${lines.length} pending records. Nothing moves until it happens.`);
    r.events.push({
      type: switching ? "plan.switched" : "plan.chosen",
      payload: {
        planId: plan.id,
        label,
        // For the Deal Engine to act on later; the Money Elf never edits a listing (#55).
        choices: plan.choices.map((c) => ({
          itemId: c.itemId,
          action: c.action,
          askCents: c.askCents,
          dropOn: c.dropOn,
        })),
        truck: plan.truck.size,
        movers: plan.movers,
        records: lines.length,
      },
    });
    return r;
  }

  async cancel(move: MoneyMove): Promise<PlanOp> {
    const r = op();
    const state = await this.store.getPlans(move.id);
    if (!state?.chosen) {
      r.lines.push("You're not on a plan.");
      return r;
    }
    for (const l of state.lines)
      if (l.status === "pending") {
        await this.money.rails.settle(l.kind, l.recordId, "cancelled");
        l.status = "cancelled";
      }
    await this.store.setPlans(move.id, {
      ...state,
      chosen: null,
      chosenLabel: null,
      chosenAt: null,
      chosenPrefix: null,
    });
    r.lines.push(`Dropped plan ${state.chosenLabel}. Its pending records in Nessie are cancelled.`);
    r.events.push({ type: "plan.cancelled", payload: { label: state.chosenLabel } });
    return r;
  }

  /** "plan B · $370 · 74% under $400 · couch 2 days behind" */
  async status(move: MoneyMove, items: MoneyItem[] | null): Promise<PlanOp> {
    const r = op();
    const state = await this.store.getPlans(move.id);
    if (!state?.chosen || !state.chosenLabel) {
      r.lines.push(`You're not on a plan. Text "plan my move under $400" (your budget) for three.`);
      return r;
    }
    const plan = items
      ? rescorePlan(
          await this.input(move, toPlanItems(items), state.budgetCents, state.moveOutDate),
          state.chosen,
        )
      : state.chosen;
    const behind = this.behind(state, items);
    r.lines.push(
      `Plan ${state.chosenLabel} · ${netPhrase(plan.stats.p50Cents)} · ${pct(plan.stats.chanceUnderBudget)} under ${fmtUsd(state.budgetCents)}${behind.length ? ` · behind on ${behind.map((b) => b.name).join(", ")}` : " · on track"}.`,
    );
    const next = state.lines
      .filter((l) => l.status === "pending" && l.lineId.startsWith(`${state.chosenPrefix}_`))
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (next) {
      const what = next.label.replace(/^Plan [ABC]: /, "").replace(/ \((expected|estimate)\)$/, "");
      r.lines.push(
        next.date < this.money.today()
          ? `Overdue: ${what}, ${fmtUsd(next.cents)}, expected by ${fmtDate(next.date)}.`
          : `Next: ${what}, ${fmtUsd(next.cents)}, by ${fmtDate(next.date)}.`,
      );
    }
    await this.record(move, state);
    return r;
  }

  /** Items still listed past the day the plan expected them to sell. */
  private behind(state: PlanState, items: MoneyItem[] | null) {
    const today = this.money.today();
    const listed = new Set((items ?? []).filter((i) => i.outcome === "listed").map((i) => i.id));
    return (state.chosen?.choices ?? []).filter(
      (c) => c.likelySaleDate && c.likelySaleDate < today && listed.has(c.itemId),
    );
  }

  /**
   * The drift sweep: settle plan records as items leave, and nudge the owner once per item that's behind when
   * the chance under budget has dropped by DRIFT_POINTS or more, with a poll to switch to a fresh plan.
   */
  async sweep(move: MoneyMove, items: MoneyItem[]): Promise<PlanOp> {
    const r = op();
    const state = await this.store.getPlans(move.id);
    if (!state?.chosen || !state.chosenLabel) return r;
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const l of state.lines) {
      if (l.status !== "pending" || !l.itemId) continue;
      const it = byId.get(l.itemId);
      const status =
        it?.outcome === "sold" || it?.outcome === "given"
          ? "completed"
          : it?.outcome === "donated" || it?.outcome === "dumped"
            ? "cancelled"
            : null;
      if (!status) continue;
      await this.money.rails.settle(l.kind, l.recordId, status);
      l.status = status;
      r.events.push({ type: "plan.line_settled", payload: { lineId: l.lineId, status } });
    }
    await this.record(move, state);

    const behind = this.behind(state, items).filter((c) => !state.nudged[c.itemId]);
    if (!behind.length) return r;
    const was = state.chosen.stats.chanceUnderBudget;
    const now = rescorePlan(
      await this.input(move, toPlanItems(items), state.budgetCents, state.moveOutDate),
      state.chosen,
    );
    const drop = was - now.stats.chanceUnderBudget;
    if (drop < DRIFT_POINTS) return r;
    for (const c of behind) state.nudged[c.itemId] = this.money.today();
    await this.store.setPlans(move.id, state);

    // Fresh drafts, so the switch offer quotes today's numbers.
    const fresh = await this.draft(move, items, state.budgetCents);
    const after = await this.store.getPlans(move.id);
    const best = after?.drafts[0];
    const named = behind.map((c) => `the ${c.name}`);
    const names =
      named.length <= 1 ? (named[0] ?? "") : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
    const lines = [
      `You're behind plan ${state.chosenLabel}: ${names} ${named.length > 1 ? "haven't" : "hasn't"} sold. ${pct(was)} → ${pct(now.stats.chanceUnderBudget)} under ${fmtUsd(state.budgetCents)}.`,
      best
        ? `Best fresh plan: ${netPhrase(best.stats.p50Cents)}, ${pct(best.stats.chanceUnderBudget)}. Switch?`
        : "",
    ].filter(Boolean);
    r.outbound.push({
      toHandle: move.ownerHandle,
      text: lines.join("\n"),
      poll: fresh.poll,
      toName: "you",
      about: "your move plan",
    });
    r.events.push({
      type: "plan.drift",
      payload: {
        label: state.chosenLabel,
        wasChance: was,
        nowChance: now.stats.chanceUnderBudget,
        items: behind.map((c) => c.itemId),
      },
    });
    return r;
  }
}
