import { describe, expect, test } from "bun:test";
import {
  checklistFor,
  type ElfContext,
  type ElfResult,
  EMPTY_CONVERSATION,
  formatChecklist,
  homeElf,
  isMoveinIntent,
  moveinSweep,
  parseAddress,
  parseMoveinFollowUp,
  reminderText,
  taskKeysIn,
} from "@elves/elves";
import { FakeListings } from "@elves/listings";
import { FakeLLM } from "@elves/llm";
import type { InboundMessage } from "@elves/photon";
import { createLogger, MemoryStore, type Move, type MoveinTask, type Participant } from "@elves/shared";

const quiet = createLogger("test", "error");
const now = new Date("2026-05-01T12:00:00Z");

describe("move-in facts", () => {
  test("intent: move-in, utilities, internet, address change; not a hunt, a sublet or a hotel", () => {
    expect(isMoveinIntent("set up internet at the new place")).toBe(true);
    expect(isMoveinIntent("what do I need for move-in")).toBe(true);
    expect(isMoveinIntent("address change and renters insurance")).toBe(true);
    expect(isMoveinIntent("moving in june 1, what's the plan")).toBe(true);
    expect(isMoveinIntent("find me a sublet in somerville, moving in june 1")).toBe(false);
    expect(isMoveinIntent("sublet my room from the move-in date")).toBe(false);
    expect(isMoveinIntent("is there a hotel for the gap between leases")).toBe(false);
  });
  test("task words: utilities means electric and gas; wifi is internet; insurance is renters insurance", () => {
    expect(taskKeysIn("done with the utilities and wifi")).toEqual(["electric", "gas", "internet"]);
    expect(taskKeysIn("skip insurance")).toEqual(["renters_insurance"]);
    expect(taskKeysIn("got the keys")).toEqual(["keys"]);
    expect(taskKeysIn("forwarded my mail")).toEqual(["address_change"]);
    expect(taskKeysIn("what's left")).toEqual([]);
  });
  test("follow-ups: done, skip, what's left, address", () => {
    expect(parseMoveinFollowUp("done with internet", now)).toEqual({ kind: "done", keys: ["internet"] });
    expect(parseMoveinFollowUp("internet is set up", now)).toEqual({ kind: "done", keys: ["internet"] });
    expect(parseMoveinFollowUp("got the keys", now)).toEqual({ kind: "done", keys: ["keys"] });
    expect(parseMoveinFollowUp("skip insurance", now)).toEqual({ kind: "skip", keys: ["renters_insurance"] });
    expect(parseMoveinFollowUp("already have renters insurance", now)).toEqual({
      kind: "skip",
      keys: ["renters_insurance"],
    });
    expect(parseMoveinFollowUp("what's left?", now)).toEqual({ kind: "left" });
    expect(parseMoveinFollowUp("address is 12 oak st apt 2, allston", now)).toEqual({
      kind: "address",
      address: "12 Oak St Apt 2, Allston",
    });
    // an order, not a report
    expect(parseMoveinFollowUp("set up internet at the new place", now)).toBeNull();
    expect(parseMoveinFollowUp("looking for a room in allston", now)).toBeNull();
  });
  test("addresses: street forms, apartment, town; a date after the comma is not a town", () => {
    expect(parseAddress("moving to 45 Harvard Ave, Allston MA 02134", now)).toBe(
      "45 Harvard Ave, Allston MA 02134",
    );
    expect(parseAddress("12 oak st, moving in may 25", now)).toBe("12 Oak St");
    expect(parseAddress("the new place is 8 Linden Street #3", now)).toBe("8 Linden Street #3");
    expect(parseAddress("done with internet", now)).toBeNull();
    expect(parseAddress("may 25", now)).toBeNull();
  });
  test("due dates hang off move-in; the bags line only when move-out comes first", () => {
    const base = { id: "mv_1", moveInAt: "2026-06-01", moveOutAt: null };
    const rows = checklistFor(base);
    expect(rows.map((r) => [r.key, r.dueAt])).toEqual([
      ["electric", "2026-05-22"],
      ["gas", "2026-05-22"],
      ["internet", "2026-05-22"],
      ["renters_insurance", "2026-05-25"],
      ["address_change", "2026-05-25"],
      ["keys", "2026-06-01"],
      ["condition_report", "2026-06-01"],
    ]);
    const gap = checklistFor({ ...base, moveOutAt: "2026-05-28" });
    expect(gap.find((r) => r.key === "luggage_gap")?.dueAt).toBe("2026-05-28");
    expect(checklistFor({ ...base, moveOutAt: "2026-06-03" }).some((r) => r.key === "luggage_gap")).toBe(
      false,
    );
    expect(checklistFor({ ...base, moveInAt: null })).toEqual([]);
  });
});

async function world(opts: { moveInAt?: string; moveOutAt?: string; toAddress?: string } = {}) {
  const store = new MemoryStore();
  let mv = await store.createMove({ ownerHandle: "+1", ownerSpaceId: "spc_1", platform: "script" });
  mv = await store.updateMove(mv.id, {
    moveInAt: opts.moveInAt ?? null,
    moveOutAt: opts.moveOutAt ?? null,
    toAddress: opts.toAddress ?? null,
  });
  const participant: Participant = await store.upsertParticipant({
    moveId: mv.id,
    handle: "+1",
    role: "owner",
    spaceId: "spc_1",
    platform: "script",
    agentUserId: "usr_agent",
  });
  let seq = 0;
  const say = async (text: string, clock: Date = now): Promise<ElfResult> => {
    const fresh = (await store.getMove(mv.id)) as Move;
    const m: InboundMessage = {
      id: `m${++seq}`,
      spaceId: "spc_1",
      spaceKind: "direct",
      platform: "script",
      senderId: "usr_1",
      senderHandle: "+1",
      agentId: "usr_agent",
      agentHandle: "+1628",
      text,
      attachments: [],
      reaction: null,
      parentMessageId: null,
      receivedAt: clock.toISOString(),
    };
    const ctx: ElfContext = {
      store,
      llm: new FakeLLM(),
      move: fresh,
      participant,
      batch: { spaceId: "spc_1", messages: [m], traceId: "t", carried: 0 },
      traceId: "t",
      log: quiet,
      signal: new AbortController().signal,
      publicUrl: null,
      firstContact: false,
      now: () => clock,
      fetchAttachment: async () => null,
      conversation: EMPTY_CONVERSATION,
      listings: new FakeListings(),
    };
    const result = await homeElf.handle(ctx);
    // The service applies the move patch after the Elf answers.
    if (result.movePatch && Object.keys(result.movePatch).length)
      await store.updateMove(mv.id, result.movePatch);
    return result;
  };
  return { store, move: mv, say };
}

const text = (r: ElfResult) => r.replies.map((x) => x.text).join("\n");

describe("Home Elf: move-in week", () => {
  test("asks for the date, then the address, then texts the checklist with dates", async () => {
    const w = await world();
    const r1 = await w.say("set up internet at the new place");
    expect(text(r1)).toBe("What day do you move in?");
    expect(r1.boardPatch).toMatchObject({ status: "waiting", lastUpdate: "Move-in: need the move-in date" });
    expect(await w.store.listMoveinTasks(w.move.id)).toEqual([]);

    const r2 = await w.say("june 1");
    expect(text(r2)).toBe("Got it: move-in Jun 1.\nWhat's the new address?");
    expect(r2.movePatch?.moveInAt).toBe("2026-06-01");

    const r3 = await w.say("12 Oak St Apt 2, Allston");
    expect(r3.movePatch?.toAddress).toBe("12 Oak St Apt 2, Allston");
    const t = text(r3);
    expect(t).toContain("Got it: 12 Oak St Apt 2, Allston.");
    expect(t).toContain("Move-in checklist for 12 Oak St Apt 2, Allston (move-in Jun 1):");
    expect(t).toContain("Electric: set up by May 22");
    expect(t).toContain("Gas: set up by May 22");
    expect(t).toContain("Internet: order by May 22");
    expect(t).toContain("Renters insurance: buy by May 25");
    expect(t).toContain("Address change: file with USPS by May 25");
    expect(t).toContain("Keys: pick up on Jun 1");
    expect(t).toContain("Condition report: photograph every room and send it to the landlord on Jun 1");
    expect(t).not.toContain("Bags for the gap");
    expect(t).toContain('Say "done with internet", "skip insurance" or "what\'s left"');
    expect(r3.events?.map((e) => e.type)).toContain("movein.checklist_created");
    expect(r3.boardPatch?.lastUpdate).toBe("Move-in Jun 1: 7 of 7 tasks open");
    const tasks = await w.store.listMoveinTasks(w.move.id);
    expect(tasks.map((x) => x.key)).toEqual([
      "electric",
      "gas",
      "internet",
      "renters_insurance",
      "address_change",
      "keys",
      "condition_report",
    ]);
    expect(tasks.every((x) => x.status === "open")).toBe(true);
  });

  test("a move that already has both facts gets the checklist at once, with the bags line and the hotel hint", async () => {
    const w = await world({ moveInAt: "2026-06-01", moveOutAt: "2026-05-28", toAddress: "45 Harvard Ave" });
    const r = await w.say("what do I need for move-in?");
    const t = text(r);
    expect(t.startsWith("Move-in checklist for 45 Harvard Ave (move-in Jun 1):")).toBe(true);
    expect(t).toContain("Bags for the gap (May 28 to Jun 1): line up storage or a friend's closet by May 28");
    expect(t).toContain('Say "find a hotel for the gap"');
    expect((await w.store.listMoveinTasks(w.move.id)).map((x) => x.key)).toContain("luggage_gap");
    // the hotel itself is the hunt's
    const hotel = await w.say("find a hotel for the gap");
    expect(text(hotel)).not.toContain("checklist");
  });

  test("follow-ups: done, skip, what's left, a changed address, a moved date", async () => {
    const w = await world({ moveInAt: "2026-06-01", toAddress: "45 Harvard Ave" });
    await w.say("move-in checklist please");

    const done = await w.say("done with internet and gas");
    expect(text(done)).toContain("Nice, gas and internet are done.");
    expect(text(done)).toContain("5 left:");
    expect(text(done)).not.toContain("Internet:");
    expect(done.events?.map((e) => e.type)).toEqual(["movein.task_done", "movein.task_done"]);
    const byKey = async () =>
      new Map((await w.store.listMoveinTasks(w.move.id)).map((x) => [x.key, x.status]));
    expect((await byKey()).get("internet")).toBe("done");
    expect((await byKey()).get("gas")).toBe("done");

    const skip = await w.say("skip insurance");
    expect(text(skip)).toContain("Skipping renters insurance.");
    expect((await byKey()).get("renters_insurance")).toBe("skipped");

    const again = await w.say("done with internet");
    expect(text(again)).toContain("Internet was already done.");

    const left = await w.say("what's left?");
    expect(text(left)).toBe(
      [
        "Still open for 45 Harvard Ave:",
        "Electric: set up by May 22",
        "Address change: file with USPS by May 25",
        "Keys: pick up on Jun 1",
        "Condition report: photograph every room and send it to the landlord on Jun 1",
      ].join("\n"),
    );

    const moved = await w.say("address is 8 Linden Street #3, Brighton");
    expect(moved.movePatch?.toAddress).toBe("8 Linden Street #3, Brighton");
    expect(text(moved)).toContain("Move-in checklist for 8 Linden Street #3, Brighton");
    expect(text(moved)).toContain("Internet: done");
    expect(moved.events?.[0]?.type).toBe("movein.checklist_updated");

    const later = await w.say("move-in moved to june 8");
    expect(later.movePatch?.moveInAt).toBe("2026-06-08");
    expect(text(later)).toContain("Electric: set up by May 29");
    expect(text(later)).toContain("Keys: pick up on Jun 8");
    expect((await byKey()).get("internet")).toBe("done");

    for (const k of ["electric", "address change", "keys", "condition report"]) await w.say(`${k} done`);
    expect(text(await w.say("what's left"))).toBe("Nothing left on the move-in list. You're set.");
  });

  test("a pending ask does not hijack a hunt, and lets go when the answer is not a date", async () => {
    const w = await world();
    await w.say("what do I need for move-in");
    const hunt = await w.say("looking for a room in allston under 1200");
    expect(text(hunt)).toContain("When do you need it");
    await w.say("utilities at the new place?");
    const shrug = await w.say("not sure yet honestly");
    expect(text(shrug)).toContain("No rush. When you know the move-in date");
    expect(shrug.boardPatch?.status).toBe("waiting");
    // the cursor is cleared: a plain date no longer lands on the checklist
    expect(text(await w.say("june 1"))).not.toContain("new address");
  });

  test("the sweep reminds about each task once, within two days of its date", async () => {
    const w = await world({ moveInAt: "2026-06-01", moveOutAt: "2026-05-28", toAddress: "45 Harvard Ave" });
    await w.say("move-in checklist");
    const quietDay = await moveinSweep(w.store, { now: new Date("2026-05-19T09:00:00Z") });
    expect(quietDay.reminders).toEqual([]);

    const first = await moveinSweep(w.store, { now: new Date("2026-05-20T09:00:00Z") });
    expect(first.reminders.map((r) => r.key)).toEqual(["electric", "gas", "internet"]);
    expect(first.reminders[2]?.text).toBe(
      'Move-in reminder: Internet is due May 22 (order before move-in). Say "done with internet" when it\'s sorted, or "skip internet".',
    );
    expect(first.reminders[0]?.moveId).toBe(w.move.id);
    expect((await moveinSweep(w.store, { now: new Date("2026-05-21T09:00:00Z") })).reminders).toEqual([]);

    await w.say("skip insurance");
    const second = await moveinSweep(w.store, { now: new Date("2026-05-25T09:00:00Z") });
    expect(second.reminders.map((r) => r.key)).toEqual(["address_change"]);
    expect(second.reminders[0]?.text.startsWith("Move-in reminder: Address change is due today")).toBe(true);

    const gap = await moveinSweep(w.store, { now: new Date("2026-05-27T09:00:00Z") });
    expect(gap.reminders.map((r) => r.key)).toEqual(["luggage_gap"]);
    expect(gap.reminders[0]?.text).toContain("Bags for the gap (May 28 to Jun 1) is due tomorrow");
    expect(gap.reminders[0]?.text).toContain('Say "done with bags"');

    const day = await moveinSweep(w.store, { now: new Date("2026-06-01T09:00:00Z") });
    expect(day.reminders.map((r) => r.key)).toEqual(["keys", "condition_report"]);
    expect(day.reminders[0]?.text).toBe(
      'Move-in reminder: Keys is due today (pick up). Say "done with keys" when it\'s sorted, or "skip keys".',
    );
    const tasks = await w.store.listMoveinTasks(w.move.id);
    expect(tasks.filter((t) => t.status === "open").every((t) => t.remindedAt != null)).toBe(true);
    expect(tasks.find((t) => t.key === "renters_insurance")?.remindedAt).toBeNull();
  });

  test("the checklist text and a reminder for a task that slipped", () => {
    const move = {
      id: "mv_1",
      moveInAt: "2026-06-01",
      moveOutAt: null,
      toAddress: "45 Harvard Ave",
    } as Move;
    const task: MoveinTask = {
      moveId: "mv_1",
      key: "internet",
      label: "Internet",
      dueAt: "2026-05-22",
      status: "open",
      notes: null,
      remindedAt: null,
      updatedAt: now.toISOString(),
    };
    expect(reminderText(task, move, new Date("2026-05-24T12:00:00Z"))).toContain("Internet was due May 22");
    expect(formatChecklist([task, { ...task, key: "gas", label: "Gas", status: "done" }], move)).toBe(
      [
        "Move-in checklist for 45 Harvard Ave (move-in Jun 1):",
        "Internet: order by May 22",
        "Gas: done",
        'Say "done with internet", "skip insurance" or "what\'s left" as you go; I\'ll nudge you as each one comes due.',
      ].join("\n"),
    );
  });
});
