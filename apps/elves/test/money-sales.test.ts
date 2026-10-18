import { afterAll, describe, expect, test } from "bun:test";
import { allElves, type Elf } from "@elves/elves";
import { FakeListings } from "@elves/listings";
import { FakeLLM } from "@elves/llm";
import { createDb, migrate, PostgresStore } from "@elves/db";
import {
  createMoneyElf,
  FakeRails,
  LEDGER_CHANGING_EVENTS,
  MemoryMoneyStore,
  PostgresMoneyStore,
} from "@elves/money-elf";
import { ScriptTransport } from "@elves/photon";
import { createLogger, MemoryStore, type Store } from "@elves/shared";
import { createMoneyBridge } from "../src/money-bridge.ts";
import { createService } from "../src/service.ts";

/**
 * Stuff and Home sales meet the Money Elf, end to end through the real service: a listing, a buyer who
 * negotiates, the owner's yes to escrow, a pickup, a release into the Moving Fund. Every money move is a Nessie
 * record (FakeRails stands in for the HTTP calls) and none happens without the owner's yes.
 */
let owner = "+16175550100";
let buyer = "+16175550199";
const pgUrl = process.env.TEST_DATABASE_URL;
const db = pgUrl ? createDb({ url: pgUrl, max: 3 }) : null;
if (db) await migrate(db, createLogger("test", "error"));
type Backend = "memory" | "postgres";
const backends: Backend[] = db ? ["memory", "postgres"] : ["memory"];
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
/** Phones of the Postgres runs, so their moves (and their deals, which cascade) are removed at the end. */
const created: string[] = [];
afterAll(async () => {
  if (db && created.length) await db`delete from moves where owner_handle in ${db(created)}`.catch(() => {});
});
const body = (t: string) => t.replace(/^(?:🧭 Crew Lead|🏠 Home Elf|📦 Stuff Elf|💸 Money Elf)\n\n/, "");

function boot(backend: Backend = "memory") {
  // Postgres runs use fresh phone numbers, so a run never meets another run's moves
  if (backend === "postgres") {
    owner = `+1617${digits(7)}`;
    buyer = `+1617${digits(7)}`;
    created.push(owner, buyer);
  } else {
    owner = "+16175550100";
    buyer = "+16175550199";
  }
  // message ids repeat from one test to the next, and Postgres remembers sends: a fresh prefix keeps them apart
  // (a listing is found through its pool agent, so each run also gets its own agent id)
  const prefix = `t${digits(6)}_`;
  const transport = new ScriptTransport(backend === "postgres" ? `usr_${prefix}` : undefined, undefined, prefix);
  const store: Store = backend === "postgres" && db ? new PostgresStore(db) : new MemoryStore();
  const rails = new FakeRails();
  const money = createMoneyElf({
    store: backend === "postgres" && db ? new PostgresMoneyStore(db) : new MemoryMoneyStore(),
    rails,
  });
  const moneyElf: Elf = { ...money, handle: (ctx) => money.handle(ctx) };
  const bridge = createMoneyBridge({ store, service: money.service });
  const service = createService({
    store,
    transport,
    llm: new FakeLLM(),
    memory: null,
    listings: new FakeListings(),
    debounceMs: 30,
    publicUrl: null,
    logger: createLogger("test", "error"),
    elves: allElves.map((e) => (e.name === "money" ? moneyElf : e)),
    refreshCardOn: LEDGER_CHANGING_EVENTS,
    onEvents: (move, events) => bridge.onEvents(move, events),
    onSweep: () => bridge.sweep(),
  });
  const ctrl = new AbortController();
  void service.run(ctrl.signal);
  const say = async (from: string, text: string, extra = {}) => {
    const before = transport.sent.length;
    transport.push(from, text, extra);
    await transport.settled();
    await service.pipeline.idle();
    return transport.sent.slice(before);
  };
  const toOwner = (sent: { spaceId: string; text: string }[]) =>
    sent.filter((s) => s.spaceId === transport.spaceFor(owner)).map((s) => body(s.text));
  const toBuyer = (sent: { spaceId: string; text: string }[]) =>
    sent.filter((s) => s.spaceId === transport.spaceFor(buyer)).map((s) => body(s.text));
  return { transport, store, rails, money, bridge, service, say, toOwner, toBuyer, stop: () => ctrl.abort() };
}

/** The owner lists a chair at a $28 floor; returns its deal. */
async function listChair(t: ReturnType<typeof boot>) {
  await t.say(owner, "moving out nov 1 and selling a chair");
  await t.say(owner, "$28 for the chair");
  await t.say(owner, "list it");
  const move = (await t.store.listMoves()).find((m) => m.ownerHandle === owner)!;
  const deal = (await t.store.listDeals(move.id))[0]!;
  return { move, deal };
}

describe.each(backends)("a sale runs through escrow in Nessie, with the owner's yes at each money move (%s)", (backend) => {
  test("agreed price → owner approves escrow → pickup → release into the Moving Fund", async () => {
    const t = boot(backend);
    const { move, deal } = await listChair(t);
    expect(t.rails.calls.filter((c) => c.op === "moveMoney")).toHaveLength(0);

    // the buyer quotes the code and takes the list price: Stuff agrees; Money asks the owner about escrow
    let sent = await t.say(buyer, `${deal.code} is the chair still available?`);
    expect(t.toBuyer(sent).length).toBeGreaterThan(0);
    sent = await t.say(buyer, "yes I'll take it");
    const ask = t.toOwner(sent).find((x) => x.includes("escrow"));
    expect(ask).toContain("Hold their payment in escrow until pickup? Reply yes.");
    expect(t.transport.polls.length).toBeGreaterThan(0);
    // nothing has moved: the question is waiting on the owner
    expect(t.rails.calls.filter((c) => c.op === "moveMoney")).toHaveLength(0);
    expect((await t.money.service.store.listPending(move.id)).map((p) => p.kind)).toEqual(["open_escrow"]);

    // the owner says yes: the buyer's money goes into the escrow account in Nessie and the buyer is told
    sent = await t.say(owner, "yes");
    expect(t.rails.calls.filter((c) => c.op === "moveMoney")).toHaveLength(1);
    expect(t.toOwner(sent).join("\n")).toContain("held in escrow");
    const held = (await t.money.service.store.listEntries(move.id)).find((e) => e.kind === "sale");
    expect(held).toMatchObject({ escrow: "held", dealId: deal.id, what: "chair" });
    expect(
      await t.store.getBoard(move.id).then((b) => b.find((r) => r.elf === "money")?.lastUpdate),
    ).toContain("in escrow");

    // a pickup slot is booked and the escrow carries its time (the 24h no-show rule)
    sent = await t.say(buyer, "1");
    expect(t.toBuyer(sent).join("\n")).toContain("Booked");
    expect((await t.money.service.store.getEntry(held!.id))?.pickupAt).toBeTruthy();

    // the buyer says they picked it up: the owner is asked to release, nothing moves yet
    sent = await t.say(buyer, "picked it up, thanks");
    expect(t.toOwner(sent).join("\n")).toContain("Reply yes");
    expect(t.rails.calls.filter((c) => c.op === "moveMoney")).toHaveLength(1);

    // the owner's yes moves it into the Moving Fund
    sent = await t.say(owner, "yes");
    expect(t.rails.calls.filter((c) => c.op === "moveMoney")).toHaveLength(2);
    expect((await t.money.service.store.getEntry(held!.id))?.escrow).toBe("released");

    // STATUS reads the Money row
    const status = (await t.say(owner, "status")).map((s) => body(s.text)).join("\n");
    expect(status).toContain("💸 Money");
    t.stop();
  });

  test("the owner declines escrow: nothing moves and the deal carries on", async () => {
    const t = boot(backend);
    const { move, deal } = await listChair(t);
    await t.say(buyer, `${deal.code} is the chair still available?`);
    await t.say(buyer, "yes I'll take it");
    await t.say(owner, "no");
    expect(t.rails.calls.filter((c) => c.op === "moveMoney")).toHaveLength(0);
    expect(await t.money.service.store.listPending(move.id)).toEqual([]);
    expect((await t.store.getDeal(deal.id))?.state).toBe("negotiating");
    t.stop();
  });

  test("the buyer walks away: a question still waiting is dropped, and money already in escrow gets a refund question", async () => {
    const t = boot(backend);
    const { move, deal } = await listChair(t);
    await t.say(buyer, `${deal.code} is the chair still available?`);
    await t.say(buyer, "yes I'll take it");
    await t.say(buyer, "never mind");
    expect(await t.money.service.store.listPending(move.id)).toEqual([]);

    // again, this time with escrow open before they walk
    await t.say(buyer, `${deal.code} is the chair still available?`);
    await t.say(buyer, "yes I'll take it");
    await t.say(owner, "yes");
    expect(t.rails.calls.filter((c) => c.op === "moveMoney")).toHaveLength(1);
    const sent = await t.say(buyer, "never mind");
    expect(t.toOwner(sent).join("\n")).toContain("Refund");
    const refunded = await t.say(owner, "yes");
    expect(t.toOwner(refunded).join("\n")).toContain("Refunded");
    expect(t.rails.calls.filter((c) => c.op === "moveMoney")).toHaveLength(2);
    t.stop();
  });

  test("the 24h no-show sweep asks the owner about a refund once, and moves nothing itself", async () => {
    const t = boot(backend);
    const { move, deal } = await listChair(t);
    await t.say(buyer, `${deal.code} is the chair still available?`);
    await t.say(buyer, "yes I'll take it");
    await t.say(owner, "yes");
    const held = (await t.money.service.store.listEntries(move.id)).find((e) => e.kind === "sale")!;
    await t.money.service.store.updateEntry(held.id, { pickupAt: "2020-01-01T00:00:00Z" });
    const before = t.transport.sent.length;
    await t.service.sweep();
    const sent = t.transport.sent
      .slice(before)
      .map((s) => body(s.text))
      .join("\n");
    expect(sent).toContain("didn't pick up");
    expect(t.rails.calls.filter((c) => c.op === "moveMoney")).toHaveLength(1);
    const again = t.transport.sent.length;
    await t.service.sweep();
    expect(t.transport.sent.length).toBe(again);
    t.stop();
  });
});

describe.each(backends)("Home's money: a sublet applicant's first month (%s)", (backend) => {
  test("an agreed sublet holds the first month in escrow after the owner's yes", async () => {
    const t = boot(backend);
    await t.say(owner, "hi");
    await t.say(owner, "moving out nov 1");
    await t.say(owner, "sublet my room for $1500");
    const move = (await t.store.listMoves()).find((m) => m.ownerHandle === owner)!;
    const deal = (await t.store.listDeals(move.id)).find((d) => d.mode === "sublet_out")!;
    await t.store.upsertDeal({ ...deal, limitCents: 120000, askCents: 150000 });
    await t.say(buyer, `${deal.code} is the room still open?`);
    const sent = await t.say(buyer, "I'll take it at $1500");
    expect(t.toOwner(sent).join("\n")).toContain("escrow");
    await t.say(owner, "yes");
    const held = (await t.money.service.store.listEntries(move.id)).find((e) => e.kind === "sale");
    expect(held?.what).toBe(`${deal.title} (first month)`);
    expect(held?.amountCents).toBe(150000);
    t.stop();
  });
});

describe("the Money Elf says hello once the brief is confirmed, and asks for the budget", () => {
  test("no budget in the brief: it asks for one and offers the plans", async () => {
    const t = boot("memory");
    const { move } = await listChair(t);
    const m = await t.bridge.onEvents(move, [{ type: "brief.confirmed", payload: { brief: { money: { budgetUsd: null } } } }]);
    expect(m.notes).toHaveLength(1);
    const note = m.notes[0]!;
    expect(note.elf).toBe("money");
    expect(note.text).toContain("I've set up your Moving Ledger in Nessie.");
    expect(note.text).toContain("three ways to finish it");
    expect(note.text).toContain("What's your budget for the rest of the move?");
    expect(note.text).toContain('"plan my move under $400"');
    expect(m.events.map((e) => e.type)).toContain("money.setup");
    expect((note.text.match(/\p{Extended_Pictographic}/gu) ?? []).length).toBeLessThanOrEqual(1);
    t.stop();
  });

  test("a budget in the brief: it offers the plans at that budget", async () => {
    const t = boot("memory");
    const { move } = await listChair(t);
    const m = await t.bridge.onEvents(move, [{ type: "brief.confirmed", payload: { brief: { money: { budgetUsd: 300 } } } }]);
    expect(m.notes[0]!.text).toContain('Text "plan my move under $300"');
    expect(m.notes[0]!.text).not.toContain("What's your budget");
    t.stop();
  });
});
