import { describe, expect, test } from "bun:test";
import {
  allElves,
  bookedPickups,
  CREW_ABILITIES,
  ELF_RELATIONS,
  elfByName,
  statusReport,
} from "@elves/elves";
import { openDeal } from "@elves/engine";
import { MemoryStore } from "@elves/shared";

describe("the Elf registry", () => {
  test("every Elf on the crew is registered by name, with the same handle(ctx) shape", () => {
    for (const e of allElves) {
      const found = elfByName(e.name);
      expect(found).toBe(e);
      expect(typeof found?.handle).toBe("function");
      expect(found?.keywords.length).toBeGreaterThan(0);
    }
    expect(elfByName("money")?.name).toBe("money");
  });
});

describe("relationships between Elves", () => {
  test("every relationship names Elves on the crew, and every ability's Elf has at least one", () => {
    const names = new Set(allElves.map((e) => e.name));
    for (const r of ELF_RELATIONS) {
      expect(names.has(r.from)).toBe(true);
      expect(names.has(r.to)).toBe(true);
      expect(r.carrier.length).toBeGreaterThan(0);
    }
    for (const elf of new Set(CREW_ABILITIES.map((a) => a.elf)))
      expect(ELF_RELATIONS.some((r) => r.from === elf || r.to === elf)).toBe(true);
  });

  test("Stuff → Home: a pickup Stuff booked shows on Home's status, with the Move Report once something sold", async () => {
    const store = new MemoryStore();
    let move = await store.createMove({ ownerHandle: "+1", ownerSpaceId: "s1", platform: "imessage" });
    move = await store.updateMove(move.id, { moveOutAt: "2026-11-01" });
    const couch = await store.upsertItem({
      moveId: move.id,
      name: "couch",
      category: "couch",
      weightLb: 150,
      outcome: "listed",
      listingApproved: true,
    });
    const deal = await openDeal(store, {
      moveId: move.id,
      mode: "sell_item",
      subjectId: couch.id,
      title: "couch",
      askCents: 8000,
      limitCents: 6000,
    });
    const slot = { id: "s", start: "2026-10-30T22:00:00Z", end: "2026-10-30T23:00:00Z", label: "Fri 6pm" };
    await store.upsertDeal({ ...deal, state: "scheduled", slot, agreedCents: 7000 });
    expect(await bookedPickups(store, move)).toEqual(["couch Fri 6pm"]);
    const s = await statusReport(store, move);
    expect(s).toContain("pickups booked: couch Fri 6pm");
    expect(s).not.toContain("Move Report");

    await store.upsertItem({
      moveId: move.id,
      name: "desk",
      category: "desk_table",
      weightLb: 60,
      outcome: "sold",
    });
    expect(await statusReport(store, move)).toContain("Move Report: about 60 lb kept off the curb");
  });
});
