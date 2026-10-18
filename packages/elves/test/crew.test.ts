import { describe, expect, test } from "bun:test";
import {
  abilitiesReply,
  abilityLine,
  CREW_ABILITIES,
  clarifyQuestion,
  crewIntro,
  crewScopePrompt,
  isCapabilitiesQuestion,
  isStatusAsk,
  outOfScope,
  parseClarify,
  pickClarifyOption,
  statusNudge,
  statusReport,
} from "@elves/elves";
import { openDeal } from "@elves/engine";
import { MemoryStore } from "@elves/shared";

describe("what the crew can and cannot do", () => {
  test("three Elves, eleven abilities, the same list in the intro, the reply and the prompt", () => {
    expect([...new Set(CREW_ABILITIES.map((a) => a.elf))]).toEqual(["home", "stuff", "money"]);
    expect(CREW_ABILITIES.length).toBe(11);
    expect(CREW_ABILITIES.filter((a) => a.elf === "money").length).toBe(5);
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
    expect(crewScopePrompt()).toContain("pay rent, bills or a landlord; move money to or from a bank");
    // every Money job the Crew Lead names is a job the Money Elf has
    const money = CREW_ABILITIES.filter((a) => a.elf === "money")
      .map((a) => a.text)
      .join(" ");
    for (const w of [
      "splits",
      "payment plans",
      "deposit",
      "escrow",
      "ledger",
      "Moving Fund",
      "odds",
      "after your yes",
    ])
      expect(money.toLowerCase()).toContain(w.toLowerCase());
  });

  test("which did you mean: the question, the options, and how an answer picks one", () => {
    const q = clarifyQuestion(["money", "stuff"]);
    expect(q).toBe(
      [
        "I can take that two ways:",
        "1. Money Elf: splitting costs, deposits, who owes what, sale money in escrow, a plan for your budget\n2. Stuff Elf: selling, buying or donating an item",
        "❓ Which did you mean? Reply 1 or 2, or say it another way.",
      ].join("\n\n"),
    );
    expect(clarifyQuestion(["home", "stuff", "money"])).toContain("three ways");
    expect(q.match(/\p{Extended_Pictographic}/gu)?.length).toBe(1);
    const two: ("home" | "stuff" | "money")[] = ["money", "stuff"];
    expect(pickClarifyOption("2", two)).toBe("stuff");
    expect(pickClarifyOption("option 1", two)).toBe("money");
    expect(pickClarifyOption("the second one", two)).toBe("stuff");
    expect(pickClarifyOption("the money one", two)).toBe("money");
    expect(pickClarifyOption("selling", two)).toBe("stuff");
    expect(pickClarifyOption("3", two)).toBeNull();
    expect(pickClarifyOption("something else entirely", two)).toBeNull();
    expect(pickClarifyOption("money or stuff?", two)).toBeNull();
    expect(parseClarify(JSON.stringify({ text: "my deposit", options: two, at: 1 }))?.text).toBe(
      "my deposit",
    );
    expect(parseClarify("")).toBeNull();
    expect(parseClarify("not json")).toBeNull();
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
    // Money's real limits: rent, bills, a landlord, a bank, investing, taxes. Its real jobs are not refused.
    for (const t of [
      "pay my rent",
      "can you pay my landlord",
      "transfer money to my bank",
      "withdraw the moving fund",
      "invest the moving fund",
      "do my taxes",
    ])
      expect(outOfScope(t)?.reply, t).toBeTruthy();
    expect(outOfScope("pay my rent")?.reply).toContain("Money Elf can split costs with roommates");
    for (const t of [
      "sublet my room for $1500",
      "find storage june to august",
      "price this couch",
      "status",
      "pay Sam $40 for gas",
      "split the $240 truck with Sam and Priya",
      "I paid a $500 sublet deposit",
      "who owes me?",
      "show me the ledger",
    ])
      expect(outOfScope(t), t).toBeNull();
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
    expect(s).toContain("💸 Money\n$60 agreed, not in escrow yet");
    // once the Money Elf keeps the Ledger, STATUS shows its line, read back from Nessie
    await store.patchBoard(move.id, "money", { lastUpdate: "Ledger: $60 in escrow, $30 from sales" });
    expect(await statusReport(store, move)).toContain("💸 Money\n$60 in escrow, $30 from sales");
    expect(s).toContain("⏳ Waiting on your yes\nA viewing Fri 6pm for the room: reply yes or no");
    // sections are separated by a blank line, and headings carry the emoji
    expect(s.split("\n\n").length).toBe(6);
    // the nudge: nothing until the last week, then the days left and the STATUS line
    expect(statusNudge("2026-11-01", new Date("2026-10-20T12:00:00Z"))).toBeNull();
    expect(statusNudge("2026-11-01", new Date("2026-10-27T12:00:00Z"))).toBe(
      "5 days to move-out. Text STATUS anytime to see where everything stands, or DASHBOARD to see your money.",
    );
    expect(statusNudge("2026-11-01", new Date("2026-11-01T12:00:00Z"))).toStartWith("Move-out is today.");
    expect(statusNudge("2026-11-01", new Date("2026-11-02T12:00:00Z"))).toBeNull();
    expect(statusNudge(null, new Date())).toBeNull();
    expect(crewIntro()).toEndWith("Text STATUS anytime to see where everything stands, or DASHBOARD to see your money.");
  });
});
