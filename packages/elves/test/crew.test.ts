import { describe, expect, test } from "bun:test";
import {
  abilitiesReply,
  abilityLine,
  CREW_ABILITIES,
  crewIntro,
  crewScopePrompt,
  isCapabilitiesQuestion,
  isStatusAsk,
  outOfScope,
  statusNudge,
  statusReport,
} from "@elves/elves";
import { openDeal } from "@elves/engine";
import { MemoryStore } from "@elves/shared";

describe("what the crew can and cannot do", () => {
  test("three Elves, seven abilities, the same list in the intro, the reply and the prompt", () => {
    expect([...new Set(CREW_ABILITIES.map((a) => a.elf))]).toEqual(["home", "stuff", "money"]);
    expect(CREW_ABILITIES.length).toBe(7);
    for (const a of CREW_ABILITIES) {
      expect(crewIntro()).toContain(abilityLine(a));
      expect(abilitiesReply()).toContain(abilityLine(a));
      expect(crewScopePrompt()).toContain(a.text);
    }
    // one emoji heading per Elf, a blank line between Elves, the limits and the STATUS line as their own blocks
    expect(crewIntro()).toContain("\n\n🏠 Home Elf\n• ");
    expect(crewIntro()).toContain("\n\n📦 Stuff Elf\n• ");
    expect(crewIntro()).toContain("\n\n💸 Money Elf\n• ");
    expect(crewIntro()).toContain("\n\n🚫 The crew can't");
    expect(crewIntro()).not.toMatch(/move-day/i);
    expect(crewScopePrompt()).toContain("What the crew cannot do: book trucks, U-Hauls or movers");
  });

  test("asks for the ability list and for status", () => {
    for (const t of ["what can you do?", "help", "What do you guys help with", "how can you help"])
      expect(isCapabilitiesQuestion(t)).toBe(true);
    expect(isCapabilitiesQuestion("can you help me sell my couch")).toBe(false);
    for (const t of ["status", "Status?", "where are we", "what's the status"])
      expect(isStatusAsk(t)).toBe(true);
    expect(isStatusAsk("what's left")).toBe(false);
    expect(isStatusAsk("status of the couch sale and also the desk")).toBe(false);
  });

  test("out-of-scope asks name what the crew can't do and the closest thing it can", () => {
    expect(outOfScope("can you book me a u-haul")?.reply).toBe(
      '🚫 The crew can\'t book trucks, U-Hauls or movers.\n\nHome Elf can find storage for the gap, and text "status" for your move checklist.',
    );
    expect(outOfScope("hire movers for saturday")?.cant).toContain("movers");
    expect(outOfScope("can you read my lease")?.cant).toBe(
      "The crew doesn't read leases or contact landlords.",
    );
    expect(outOfScope("email my landlord that I'm leaving")?.cant).toContain("landlords");
    expect(outOfScope("post it on facebook marketplace for me")?.cant).toBe(
      "The crew doesn't post listings for you.",
    );
    expect(outOfScope("venmo the deposit for me")?.cant).toContain("money");
    for (const t of ["sublet my room for $1500", "find storage june to august", "price this couch", "status"])
      expect(outOfScope(t)).toBeNull();
  });
});

describe("statusReport", () => {
  test("an empty move says what's missing", async () => {
    const store = new MemoryStore();
    const move = await store.createMove({ ownerHandle: "+1", ownerSpaceId: "s1", platform: "imessage" });
    expect(await statusReport(store, move)).toBe(
      [
        "📋 STATUS",
        "🗓 Dates\nNo move dates yet.",
        "🏠 Home\nChecklist: starts once I have your move-in date.",
      ].join("\n\n"),
    );
  });

  test("dates, the checklist, stuff, the ledger and what waits on the owner, in one paragraph", async () => {
    const store = new MemoryStore();
    let move = await store.createMove({ ownerHandle: "+1", ownerSpaceId: "s1", platform: "imessage" });
    move = await store.updateMove(move.id, {
      moveOutAt: "2026-11-01",
      moveInAt: "2026-11-03",
      fromAddress: "Allston",
      toAddress: "12 Elm St",
    });
    await store.upsertMoveinTask({
      moveId: move.id,
      key: "internet",
      label: "Internet",
      dueAt: "2026-10-24",
      status: "done",
    });
    await store.upsertMoveinTask({ moveId: move.id, key: "keys", label: "Keys", dueAt: "2026-11-03" });
    await store.upsertItem({
      moveId: move.id,
      name: "couch",
      category: "furniture",
      outcome: "listed",
      listingApproved: true,
    });
    await store.upsertItem({ moveId: move.id, name: "desk", category: "furniture", outcome: "sold" });
    await store.appendEvent({
      moveId: move.id,
      type: "ledger.hold",
      payload: { cents: 6000 },
      traceId: null,
    });
    const deal = await openDeal(store, {
      moveId: move.id,
      mode: "sublet_out",
      subjectId: null,
      title: "room",
      askCents: 140000,
      limitCents: 120000,
    });
    const party = await store.upsertDealParty({
      dealId: deal.id,
      moveId: move.id,
      spaceId: "spc_a",
      handle: "+2",
      role: "applicant",
      status: "awaiting_owner",
      agreedCents: 140000,
      slot: { id: "s", start: "2026-10-16T22:00:00Z", end: "2026-10-16T23:00:00Z", label: "Fri 6pm" },
    });
    expect(party.status).toBe("awaiting_owner");

    const s = await statusReport(store, move);
    expect(s).toStartWith("📋 STATUS\n\n🗓 Dates\nOut Nov 1 from Allston\nIn Nov 3 at 12 Elm St\n\n🏠 Home\n");
    expect(s).toContain("Checklist: 1 to go\n  • Keys: pick up on Nov 3\n  ✅ Done: Internet");
    expect(s).toContain("📦 Stuff\nListed: couch\nSold: desk");
    expect(s).toContain("💸 Money\n$60 held in escrow");
    expect(s).toContain("⏳ Waiting on your yes\nA viewing Fri 6pm for the room: reply yes or no");
    // sections are separated by a blank line, and headings carry the emoji
    expect(s.split("\n\n").length).toBe(6);
    // the nudge: nothing until the last week, then the days left and the STATUS line
    expect(statusNudge("2026-11-01", new Date("2026-10-20T12:00:00Z"))).toBeNull();
    expect(statusNudge("2026-11-01", new Date("2026-10-27T12:00:00Z"))).toBe(
      "5 days to move-out. Text STATUS anytime to see where everything stands.",
    );
    expect(statusNudge("2026-11-01", new Date("2026-11-01T12:00:00Z"))).toStartWith("Move-out is today.");
    expect(statusNudge("2026-11-01", new Date("2026-11-02T12:00:00Z"))).toBeNull();
    expect(statusNudge(null, new Date())).toBeNull();
    expect(crewIntro()).toEndWith("Text STATUS anytime to see where everything stands.");
  });
});
