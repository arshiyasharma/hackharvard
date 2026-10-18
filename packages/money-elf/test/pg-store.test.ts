import { afterAll, describe, expect, test } from "bun:test";
import { createDb, migrate, PostgresStore } from "@elves/db";
import { createLogger } from "@elves/shared";
import { MemoryMoneyStore, type MoneyStore } from "../src/ledger.ts";
import { PostgresMoneyStore } from "../src/pg-store.ts";
import { FakeRails } from "../src/rails.ts";
import { MoneyService } from "../src/service.ts";

/**
 * The MoneyStore contract and the escrow flow on top of it, against memory always and against Postgres when
 * TEST_DATABASE_URL is set (bun run test:pg). The Postgres run also proves the Elf's own state survives a
 * restart: a new store over the same database still sees the owner's waiting approval and the escrow.
 */
const run = `mt${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
const quiet = createLogger("test", "error");
const pgUrl = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-10-18T15:00:00Z");
const OWNER = "+16175550100";

interface Backend {
  name: string;
  open: () => Promise<{
    store: MoneyStore;
    moveId: string;
    reopen: () => MoneyStore;
    cleanup: () => Promise<void>;
  }>;
}

const backends: Backend[] = [
  {
    name: "memory",
    open: async () => {
      const store = new MemoryMoneyStore();
      return { store, moveId: "mv_mem", reopen: () => store, cleanup: async () => {} };
    },
  },
];
if (pgUrl)
  backends.push({
    name: "postgres",
    open: async () => {
      const db = createDb({ url: pgUrl, max: 2 });
      await migrate(db, quiet);
      const crew = new PostgresStore(db);
      const move = await crew.createMove({
        ownerHandle: `${run}:${crypto.randomUUID()}`,
        ownerSpaceId: run,
        platform: "script",
      });
      return {
        store: new PostgresMoneyStore(db),
        moveId: move.id,
        reopen: () => new PostgresMoneyStore(db),
        cleanup: async () => {
          await db`delete from moves where id = ${move.id}`;
          await db.end();
        },
      };
    },
  });

describe.each(backends)("MoneyStore contract ($name)", (backend) => {
  const cleanups: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of cleanups) await c();
  });
  const open = async () => {
    const o = await backend.open();
    cleanups.push(o.cleanup);
    return o;
  };

  test("people, entries and pending approvals round-trip, in order, with their json and nulls", async () => {
    const { store, moveId } = await open();
    const sam = await store.upsertPerson({ moveId, name: "Sam", role: "roommate", handle: "+16175550101" });
    const again = await store.upsertPerson({ ...sam, nessieAccountId: "acct_1" });
    expect(again.id).toBe(sam.id);
    expect((await store.listPeople(moveId)).map((p) => [p.name, p.handle, p.nessieAccountId])).toEqual([
      ["Sam", "+16175550101", "acct_1"],
    ]);
    expect((await store.getPerson(sam.id))?.role).toBe("roommate");

    const e = await store.addEntry({
      moveId,
      date: "2026-10-18",
      kind: "sale",
      what: "couch",
      amountCents: 6000,
      escrow: "held",
      dealId: "d1",
      partyId: "p1",
    });
    expect(e).toMatchObject({
      escrow: "held",
      dealId: "d1",
      partyId: "p1",
      flagged: false,
      paidCents: 0,
      loanMonthlyCents: null,
    });
    expect(e.nessie).toEqual({ withdrawalIds: [], depositIds: [], purchaseIds: [], billId: null });
    const up = await store.updateEntry(e.id, {
      buyerConfirmedAt: "2026-10-18T16:00:00Z",
      nessie: { ...e.nessie, depositIds: ["dep_1"] },
    });
    expect(up.buyerConfirmedAt).toBe("2026-10-18T16:00:00Z");
    expect((await store.getEntry(e.id))?.nessie.depositIds).toEqual(["dep_1"]);
    await expect(
      store.addEntry({ moveId, date: "2026-10-18", kind: "expense", what: "x", amountCents: 0 }),
    ).rejects.toThrow();

    const a = await store.addPending({
      moveId,
      kind: "open_escrow",
      summary: "first",
      entryIds: [],
      data: { dealId: "d1", amountCents: 6000 },
    });
    const b = await store.addPending({ moveId, kind: "release_escrow", summary: "second", entryIds: [e.id] });
    expect((await store.listPending(moveId)).map((p) => p.summary)).toEqual(["first", "second"]);
    expect(b.createdAt.localeCompare(a.createdAt)).toBeGreaterThan(0);
    const patched = await store.updatePending(a.id, {
      data: { dealId: "d1", amountCents: 6000, pickupAt: "2026-10-20T14:00:00Z" },
    });
    expect(patched.data?.pickupAt).toBe("2026-10-20T14:00:00Z");
    await store.removePending(a.id);
    expect((await store.listPending(moveId)).map((p) => p.summary)).toEqual(["second"]);

    expect(await store.getEscrowAccount(moveId)).toBeUndefined();
    await store.setEscrowAccount(moveId, "acct_escrow");
    await store.setFundAccount(moveId, "acct_fund");
    expect([await store.getEscrowAccount(moveId), await store.getFundAccount(moveId)]).toEqual([
      "acct_escrow",
      "acct_fund",
    ]);
  });

  test("a sale through escrow: the owner approves opening it, the buyer's pickup and the owner's yes release it, and a restart loses nothing", async () => {
    const { store, moveId, reopen } = await open();
    const rails = new FakeRails();
    const service = () => new MoneyService(reopen(), rails, () => NOW);
    const move = { id: moveId, ownerHandle: OWNER, name: "Gavin" };

    // Stuff's deal agreed $60 with a buyer: the owner is asked, nothing moves yet
    const asked = await service().proposeOpenEscrow(move, {
      item: "couch",
      buyerName: "Buyer …0199",
      buyerHandle: "+16175550199",
      amountCents: 6000,
      dealId: "d1",
      partyId: "p1",
    });
    expect(asked.lines.join(" ")).toContain("Hold their payment in escrow until pickup? Reply yes.");
    expect(rails.calls.filter((c) => c.op === "moveMoney")).toHaveLength(0);
    await service().pickupScheduled(move, "d1", "p1", "2026-10-20T14:00:00Z");

    // "restart": a new service over the same store still has the owner's waiting yes
    const pending = await service().latestPending(moveId);
    expect(pending?.kind).toBe("open_escrow");
    expect(pending?.data?.pickupAt).toBe("2026-10-20T14:00:00Z");

    const opened = await service().approve(move);
    expect(opened.events.map((e) => e.type)).toContain("escrow.opened");
    const held = await service().heldForDeal(moveId, "d1", "p1");
    expect(held).toMatchObject({
      amountCents: 6000,
      escrow: "held",
      pickupAt: "2026-10-20T14:00:00Z",
      what: "couch",
    });
    expect(rails.calls.filter((c) => c.op === "moveMoney")).toHaveLength(1);

    // the buyer picks up (the engine's hand-off): the owner is asked to release
    const handed = await service().confirmPickup(move, { via: "engine", entryId: held?.id });
    expect(handed.outbound.some((o) => o.toHandle === OWNER && o.text.includes("Reply yes"))).toBe(true);
    const released = await service().approve(move);
    expect(released.events.map((e) => e.type)).toContain("escrow.released");
    expect((await reopen().getEntry(held!.id))?.escrow).toBe("released");
    expect(rails.calls.filter((c) => c.op === "moveMoney")).toHaveLength(2);
  });

  test("a walk-away before the owner opens escrow drops the question; after, it stages a refund for the owner's yes", async () => {
    const { store, moveId } = await open();
    const rails = new FakeRails();
    const service = new MoneyService(store, rails, () => NOW);
    const move = { id: moveId, ownerHandle: OWNER, name: "Gavin" };
    await service.proposeOpenEscrow(move, {
      item: "lamp",
      buyerName: "Buyer …0001",
      buyerHandle: null,
      amountCents: 1500,
      dealId: "d2",
      partyId: "p2",
    });
    expect(await service.dropOpenEscrow(moveId, "d2", "p2")).toBe(true);
    expect(await store.listPending(moveId)).toEqual([]);

    await service.proposeOpenEscrow(move, {
      item: "desk",
      buyerName: "Buyer …0002",
      buyerHandle: null,
      amountCents: 3000,
      dealId: "d3",
      partyId: "p3",
    });
    await service.approve(move);
    const walked = await service.proposeEscrow(move, "refund_escrow", "desk");
    expect(walked.lines.join(" ")).toContain("Refund");
    const refunded = await service.approve(move);
    expect(refunded.events.map((e) => e.type)).toContain("escrow.refunded");
    expect(await service.heldForDeal(moveId, "d3", "p3")).toBeUndefined();
  });
});
