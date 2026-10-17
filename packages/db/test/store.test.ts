import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, migrate, PostgresStore } from "@elves/db";
import { createLogger, MemoryStore, newId, type Store } from "@elves/shared";

/**
 * The Store contract, run against the in-memory store always and against Postgres when TEST_DATABASE_URL is
 * set (bun run test:pg starts from the local container; the suite only touches rows it created).
 */
const run = newId("t");
const handle = (n: string) => `${run}:${n}`;
const quiet = createLogger("test", "error");
const pgUrl = process.env.TEST_DATABASE_URL;

const backends: [string, () => Promise<{ store: Store; cleanup: () => Promise<void> }>][] = [
  ["memory", async () => ({ store: new MemoryStore(), cleanup: async () => {} })],
];
if (pgUrl) {
  backends.push([
    "postgres",
    async () => {
      const db = createDb({ url: pgUrl, max: 2 });
      await migrate(db, quiet);
      return {
        store: new PostgresStore(db),
        cleanup: async () => {
          // listings, housing_searches and movein_tasks cascade from moves
          await db`delete from moves where owner_handle like ${`${run}:%`}`;
          await db`delete from events where move_id is null and trace_id = ${run}`;
          await db`delete from thread_owners where message_id like ${`${run}:%`}`;
          await db`delete from sends where key like ${`${run}:%`}`;
          await db`delete from cursors where name like ${`${run}:%`}`;
          await db.end();
        },
      };
    },
  ]);
}

describe.each(backends)("Store contract (%s)", (_name, open) => {
  let store: Store;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ store, cleanup } = await open()));
  afterAll(async () => cleanup());

  test("createMove seeds the Crew Board and is found by id, owner space and owner handle", async () => {
    const move = await store.createMove({
      ownerHandle: handle("owner1"),
      ownerSpaceId: handle("spc1"),
      platform: "imessage",
    });
    expect(move.id.startsWith("mv_")).toBe(true);
    expect(move.moveOutAt).toBeNull();
    expect(move.boardLinkSent).toBe(false);
    expect((await store.getMove(move.id))?.id).toBe(move.id);
    expect((await store.getMoveBySpace(handle("spc1")))?.id).toBe(move.id);
    expect((await store.getMoveByOwnerHandle(handle("owner1")))?.id).toBe(move.id);
    expect(await store.getMove("mv_nope")).toBeUndefined();
    const board = await store.getBoard(move.id);
    expect(board.map((b) => b.elf)).toEqual(["crew_lead", "stuff", "money", "moveday", "home"]);
    expect(board[0]).toMatchObject({ status: "working", currentTask: "Getting the move set up" });
    expect(board[1]).toMatchObject({ status: "idle", currentTask: "Standing by" });
  });

  test("updateMove merges a patch and bumps updatedAt", async () => {
    const move = await store.createMove({
      ownerHandle: handle("owner2"),
      ownerSpaceId: handle("spc2"),
      platform: "sms",
    });
    await new Promise((r) => setTimeout(r, 5));
    const next = await store.updateMove(move.id, {
      moveOutAt: "2026-11-01",
      fromAddress: "12 Oak St",
      boardLinkSent: true,
    });
    expect(next).toMatchObject({
      moveOutAt: "2026-11-01",
      fromAddress: "12 Oak St",
      boardLinkSent: true,
      moveInAt: null,
    });
    expect(next.updatedAt >= move.updatedAt).toBe(true);
    expect((await store.getMove(move.id))?.moveOutAt).toBe("2026-11-01");
    await expect(store.updateMove("mv_nope", { name: "x" })).rejects.toThrow();
  });

  test("participants are keyed by space and link a space to the move", async () => {
    const move = await store.createMove({
      ownerHandle: handle("owner3"),
      ownerSpaceId: handle("spc3"),
      platform: "imessage",
    });
    const p1 = await store.upsertParticipant({
      moveId: move.id,
      handle: handle("owner3"),
      role: "owner",
      spaceId: handle("spc3"),
      platform: "imessage",
      agentUserId: "usr_a",
    });
    const p2 = await store.upsertParticipant({
      moveId: move.id,
      handle: handle("owner3"),
      role: "owner",
      spaceId: handle("spc3"),
      platform: "imessage",
      agentUserId: "usr_b",
    });
    expect(p2.id).toBe(p1.id);
    expect(p2.agentUserId).toBe("usr_b");
    await store.upsertParticipant({
      moveId: move.id,
      handle: handle("buyer"),
      role: "buyer",
      spaceId: handle("spc3b"),
      platform: "imessage",
      agentUserId: "usr_a",
    });
    expect((await store.listParticipants(move.id)).map((p) => p.role)).toEqual(["owner", "buyer"]);
    expect((await store.getParticipantBySpace(handle("spc3b")))?.role).toBe("buyer");
    expect((await store.getMoveBySpace(handle("spc3b")))?.id).toBe(move.id);
    expect(await store.getMoveBySpace(handle("spc-none"))).toBeUndefined();
  });

  test("patchBoard updates one Elf and creates a row when missing", async () => {
    const move = await store.createMove({
      ownerHandle: handle("owner4"),
      ownerSpaceId: handle("spc4"),
      platform: "imessage",
    });
    const row = await store.patchBoard(move.id, "stuff", { status: "working", currentTask: "Listing couch" });
    expect(row).toMatchObject({
      elf: "stuff",
      status: "working",
      currentTask: "Listing couch",
      lastUpdate: "",
    });
    const again = await store.patchBoard(move.id, "stuff", { lastUpdate: "Floor $80" });
    expect(again).toMatchObject({ status: "working", currentTask: "Listing couch", lastUpdate: "Floor $80" });
    expect((await store.getBoard(move.id)).find((b) => b.elf === "stuff")?.lastUpdate).toBe("Floor $80");
  });

  test("events append in order with JSON payloads", async () => {
    const move = await store.createMove({
      ownerHandle: handle("owner5"),
      ownerSpaceId: handle("spc5"),
      platform: "imessage",
    });
    await store.appendEvent({
      moveId: move.id,
      type: "a",
      payload: { n: 1, nested: { ok: true } },
      traceId: run,
    });
    await store.appendEvent({ moveId: move.id, type: "b", payload: {}, traceId: null });
    await store.appendEvent({ moveId: null, type: "global", payload: { x: "y" }, traceId: run });
    const evs = await store.listEvents(move.id);
    expect(evs.map((e) => e.type)).toEqual(["a", "b"]);
    expect(evs[0]?.payload).toEqual({ n: 1, nested: { ok: true } });
    expect(evs[0]?.traceId).toBe(run);
    expect(evs[1]?.traceId).toBeNull();
  });

  test("upsertItem creates with defaults, merges patches by id, and lists in creation order", async () => {
    const move = await store.createMove({
      ownerHandle: handle("owner6"),
      ownerSpaceId: handle("spc6"),
      platform: "imessage",
    });
    const couch = await store.upsertItem({ moveId: move.id, name: "couch", category: "couch" });
    expect(couch).toMatchObject({
      weightLb: 25,
      title: null,
      listPriceCents: null,
      photoAttachmentIds: [],
      listingApproved: false,
      outcome: "listed",
    });
    await store.upsertItem({ moveId: move.id, name: "lamp", category: "small", weightLb: 10 });
    const priced = await store.upsertItem({
      id: couch.id,
      moveId: move.id,
      name: "couch",
      category: "couch",
      floorPriceCents: 8000,
      listPriceCents: 12000,
      photoAttachmentIds: ["att1"],
    });
    expect(priced.id).toBe(couch.id);
    expect(priced).toMatchObject({
      floorPriceCents: 8000,
      listPriceCents: 12000,
      photoAttachmentIds: ["att1"],
      weightLb: 25,
    });
    const approved = await store.upsertItem({
      id: couch.id,
      moveId: move.id,
      name: "couch",
      category: "couch",
      listingApproved: true,
    });
    expect(approved).toMatchObject({
      floorPriceCents: 8000,
      listingApproved: true,
      photoAttachmentIds: ["att1"],
    });
    expect((await store.listItems(move.id)).map((i) => i.name)).toEqual(["couch", "lamp"]);
  });

  test("thread owners, sends and cursors are idempotent key-value state", async () => {
    await store.setThreadOwner(handle("out1"), "stuff");
    await store.setThreadOwner(handle("out1"), "money");
    expect(await store.getThreadOwner(handle("out1"))).toBe("money");
    expect(await store.getThreadOwner(handle("nope"))).toBeUndefined();
    expect(await store.getSend(handle("reply:1"))).toBeUndefined();
    await store.recordSend(handle("reply:1"), "msg_9");
    expect((await store.getSend(handle("reply:1")))?.messageId).toBe("msg_9");
    await store.recordSend(handle("reply:1"), null);
    expect((await store.getSend(handle("reply:1")))?.messageId).toBe("msg_9");
    expect(await store.getCursor(handle("c"))).toBeUndefined();
    await store.setCursor(handle("c"), "2026-10-17T00:00:00Z");
    await store.setCursor(handle("c"), "2026-10-17T00:01:00Z");
    expect(await store.getCursor(handle("c"))).toBe("2026-10-17T00:01:00Z");
  });

  test("housing search is one row per move; listings upsert by id or by url and keep their status", async () => {
    const move = await store.createMove({
      ownerHandle: handle("owner8"),
      ownerSpaceId: handle("spc8"),
      platform: "imessage",
    });
    expect(await store.getSearch(move.id)).toBeUndefined();
    const search = await store.saveSearch({
      moveId: move.id,
      kinds: ["room"],
      city: "Boston, MA",
      neighborhoods: ["Allston"],
      budgetMaxCents: 120000,
      hotelNightlyMaxCents: null,
      moveIn: "2026-06-01",
      moveOut: "2026-08-30",
      bedrooms: null,
      furnished: null,
      mustHaves: ["near the T"],
      notes: [],
      lastSearchedAt: null,
      lastSearchKey: null,
      shownCount: 0,
    });
    expect(search.updatedAt).toBeTruthy();
    const again = await store.saveSearch({
      ...search,
      neighborhoods: ["Allston", "Brighton"],
      shownCount: 3,
    });
    expect((await store.getSearch(move.id))?.neighborhoods).toEqual(["Allston", "Brighton"]);
    expect(again.shownCount).toBe(3);
    expect(again.mustHaves).toEqual(["near the T"]);

    const url = "https://boston.craigslist.org/gbs/roo/d/x/1.html";
    const first = await store.upsertListing({
      moveId: move.id,
      site: "craigslist",
      kind: "room",
      url,
      title: "Sunny room",
      priceCents: 110000,
      location: "Allston",
      contact: { phone: "617", email: null, messageUrl: null },
    });
    expect(first.id.startsWith("ls_")).toBe(true);
    expect(first).toMatchObject({ status: "found", score: 0, rank: null, scamFlags: [], priceUnit: "month" });
    const shortlisted = await store.upsertListing({
      id: first.id,
      moveId: move.id,
      site: "craigslist",
      kind: "room",
      url,
      title: "Sunny room",
      status: "shortlisted",
    });
    expect(shortlisted.priceCents).toBe(110000);
    // re-found by url: new rank and score, status kept
    const refound = await store.upsertListing({
      moveId: move.id,
      site: "craigslist",
      kind: "room",
      url,
      title: "Sunny room",
      rank: 1,
      score: 90,
      scamFlags: [],
    });
    expect(refound.id).toBe(first.id);
    expect(refound).toMatchObject({ status: "shortlisted", rank: 1, score: 90, contact: { phone: "617" } });
    await store.upsertListing({
      moveId: move.id,
      site: "airbnb",
      kind: "room",
      url: "https://www.airbnb.com/rooms/1",
      title: "Other",
    });
    expect((await store.listListings(move.id)).map((l) => l.site)).toEqual(["craigslist", "airbnb"]);
  });

  test("the sublet post is one row per move and round-trips every field", async () => {
    const move = await store.createMove({
      ownerHandle: handle("owner9"),
      ownerSpaceId: handle("spc9"),
      platform: "imessage",
    });
    expect(await store.getSubletPost(move.id)).toBeUndefined();
    const post = await store.saveSubletPost({
      moveId: move.id,
      dealId: null,
      rentCents: 150000,
      availableFrom: "2026-06-01",
      availableUntil: null,
      area: "Allston",
      furnished: true,
      roomType: "private room in a 3BR",
      details: ["laundry in building"],
      photoAttachmentIds: [],
      photoNotes: null,
      title: null,
      body: null,
      status: "collecting",
    });
    expect(post.updatedAt).toBeTruthy();
    const drafted = await store.saveSubletPost({
      ...post,
      dealId: "dl_1",
      availableUntil: "2026-08-31",
      photoAttachmentIds: ["att1"],
      photoNotes: "Bright room with a big window.",
      title: "Furnished room in Allston",
      body: "Text us.",
      status: "drafted",
    });
    expect(drafted).toMatchObject({
      dealId: "dl_1",
      rentCents: 150000,
      availableUntil: "2026-08-31",
      furnished: true,
      details: ["laundry in building"],
      photoAttachmentIds: ["att1"],
      status: "drafted",
    });
    expect((await store.getSubletPost(move.id))?.title).toBe("Furnished room in Allston");
  });

  test("a lease reading is one row per move and a new PDF replaces it", async () => {
    const move = await store.createMove({
      ownerHandle: handle("owner10"),
      ownerSpaceId: handle("spc10"),
      platform: "imessage",
    });
    expect(await store.getLeaseReading(move.id)).toBeUndefined();
    const first = await store.saveLeaseReading({
      moveId: move.id,
      attachmentId: "att_lease1",
      filename: "lease.pdf",
      reading: { sublet: "with_consent", noticeDays: 30, nested: { ok: true } },
    });
    expect(first.readAt).toBeTruthy();
    const second = await store.saveLeaseReading({
      moveId: move.id,
      attachmentId: "att_lease2",
      filename: null,
      reading: { sublet: "prohibited" },
    });
    expect(second.attachmentId).toBe("att_lease2");
    expect((await store.getLeaseReading(move.id))?.reading).toEqual({ sublet: "prohibited" });
  });

  test("move-in tasks are one row per (move, key), keep status on re-upsert, and list due ones once", async () => {
    const move = await store.createMove({
      ownerHandle: handle("owner11"),
      ownerSpaceId: handle("spc11"),
      platform: "imessage",
    });
    expect(await store.listMoveinTasks(move.id)).toEqual([]);
    const keys = await store.upsertMoveinTask({
      moveId: move.id,
      key: "keys",
      label: "Keys",
      dueAt: "2026-06-01",
    });
    expect(keys).toMatchObject({ status: "open", notes: null, remindedAt: null });
    expect(keys.updatedAt).toBeTruthy();
    await store.upsertMoveinTask({
      moveId: move.id,
      key: "internet",
      label: "Internet",
      dueAt: "2026-05-22",
    });
    await store.upsertMoveinTask({
      moveId: move.id,
      key: "electric",
      label: "Electric",
      dueAt: "2026-05-22",
    });
    // checklist order: by due date, then the fixed key order
    expect((await store.listMoveinTasks(move.id)).map((t) => t.key)).toEqual([
      "electric",
      "internet",
      "keys",
    ]);

    const done = await store.upsertMoveinTask({
      moveId: move.id,
      key: "internet",
      label: "Internet",
      dueAt: "2026-05-22",
      status: "done",
      notes: "Xfinity, installed",
    });
    expect(done).toMatchObject({ status: "done", notes: "Xfinity, installed" });
    // a re-upsert with a new date keeps status and notes
    const moved = await store.upsertMoveinTask({
      moveId: move.id,
      key: "internet",
      label: "Internet",
      dueAt: "2026-05-29",
    });
    expect(moved).toMatchObject({ dueAt: "2026-05-29", status: "done", notes: "Xfinity, installed" });
    expect((await store.listMoveinTasks(move.id)).length).toBe(3);

    // due: open, not yet reminded, on or before the date; this move's rows only
    const due = (await store.listDueMoveinTasks("2026-05-24")).filter((t) => t.moveId === move.id);
    expect(due.map((t) => t.key)).toEqual(["electric"]);
    await store.upsertMoveinTask({ ...due[0]!, remindedAt: "2026-05-20T09:00:00.000Z" });
    expect((await store.listDueMoveinTasks("2026-05-24")).filter((t) => t.moveId === move.id)).toEqual([]);
    expect((await store.listMoveinTasks(move.id)).find((t) => t.key === "electric")?.remindedAt).toBe(
      "2026-05-20T09:00:00.000Z",
    );
    const all = (await store.listDueMoveinTasks("2026-06-01")).filter((t) => t.moveId === move.id);
    expect(all.map((t) => t.key)).toEqual(["keys"]);
  });

  test("listMoves returns every move in creation order", async () => {
    const before = (await store.listMoves()).length;
    const a = await store.createMove({
      ownerHandle: handle("owner7a"),
      ownerSpaceId: handle("spc7a"),
      platform: "imessage",
    });
    const b = await store.createMove({
      ownerHandle: handle("owner7b"),
      ownerSpaceId: handle("spc7b"),
      platform: "imessage",
    });
    const all = await store.listMoves();
    expect(all.length).toBe(before + 2);
    expect(all.indexOf(all.find((m) => m.id === a.id)!)).toBeLessThan(
      all.indexOf(all.find((m) => m.id === b.id)!),
    );
  });
});
