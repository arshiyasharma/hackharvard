import { describe, expect, test } from "bun:test";
import {
  type ElfContext,
  type ElfOutboundToHandle,
  type ElfResult,
  EMPTY_CONVERSATION,
  homeElf,
  phoneHandle,
} from "@elves/elves";
import { FakeListings, type ListingSource } from "@elves/listings";
import { FakeLLM } from "@elves/llm";
import type { InboundMessage } from "@elves/photon";
import { createLogger, MemoryStore, type Move, type Participant } from "@elves/shared";

const quiet = createLogger("test", "error");
const now = new Date("2026-03-01T12:00:00Z");

async function world(opts: { listings?: ListingSource; moveOutAt?: string | null } = {}) {
  const store = new MemoryStore();
  let move = await store.createMove({ ownerHandle: "+1", ownerSpaceId: "spc_1", platform: "script" });
  if (opts.moveOutAt) move = await store.updateMove(move.id, { moveOutAt: opts.moveOutAt });
  const participant: Participant = await store.upsertParticipant({
    moveId: move.id,
    handle: "+1",
    role: "owner",
    spaceId: "spc_1",
    platform: "script",
    agentUserId: "usr_agent",
  });
  const listings = opts.listings ?? new FakeListings();
  let seq = 0;
  const say = async (text: string, clock: Date = now): Promise<ElfResult> => {
    const fresh = (await store.getMove(move.id)) as Move;
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
      listings,
    };
    return homeElf.handle(ctx);
  };
  return { store, move, say, listings };
}

const text = (r: ElfResult) => r.replies.map((x) => x.text).join("\n");

describe("Home Elf: hunt", () => {
  test("asks for one thing at a time, then searches", async () => {
    const w = await world();
    const r1 = await w.say("find me a room in allston");
    expect(text(r1)).toContain("most you'd want to pay");
    expect(r1.later).toBeUndefined();
    expect(r1.boardPatch?.status).toBe("waiting");
    expect((await w.store.getSearch(w.move.id))?.neighborhoods).toEqual(["Allston"]);

    const r2 = await w.say("under 1200");
    expect(text(r2)).toContain("When do you need it");
    expect((await w.store.getSearch(w.move.id))?.budgetMaxCents).toBe(120000);

    const r3 = await w.say("june 1 to aug 30");
    expect(r3.later).toBeDefined();
    expect(text(r3)).toContain(
      "Checking Craigslist, Apartments.com and Airbnb for a room in Allston under $1,200",
    );
    expect(r3.events?.map((e) => e.type)).toContain("housing.search_started");
    expect(r3.movePatch?.moveInAt).toBe("2026-06-01");

    const done = await r3.later!();
    const t = text(done);
    expect(t.startsWith("Top picks for a room in Allston under $1,200 (Jun 1 – Aug 30):")).toBe(true);
    expect(t).toContain("1. Sunny furnished room near Packard's Corner · $1,100/mo · Allston");
    expect(t).toContain("https://boston.craigslist.org/");
    expect(t).toContain("2. Allston Green");
    expect(t).toContain("3. Private room in Allston");
    expect(t).toContain("Skipped 1 that looks like a scam");
    expect(t).toContain('"tell me about 1"');
    expect(done.boardPatch?.status).toBe("working");
    expect(done.events?.[0]?.type).toBe("housing.search_done");

    const stored = await w.store.listListings(w.move.id);
    expect(stored.filter((l) => l.rank != null).map((l) => l.rank)).toEqual([1, 2, 3]);
    const scam = stored.find((l) => l.priceCents === 40000)!;
    expect(scam.rank).toBeNull();
    expect(scam.scamFlags).toContain("wire_or_prepay");
    const search = (await w.store.getSearch(w.move.id))!;
    expect(search.lastSearchedAt).toBe(now.toISOString());
    expect(search.shownCount).toBe(3);
    expect((w.listings as FakeListings).calls[0]?.map((q) => q.kind)).toEqual(["room"]);
  });

  test("follow-ups: detail, more, skip, save", async () => {
    const w = await world();
    const r = await w.say("looking for a room in allston under 1200 june 1 to aug 30");
    await r.later!();

    const detail = await w.say("tell me about 2");
    expect(text(detail)).toContain("2. Allston Green");
    expect(text(detail)).toContain("https://www.apartments.com/");
    expect(text(detail)).toContain("Phone on the listing: (617) 555-0142");

    expect(text(await w.say("more"))).toContain("That's everything I found");
    expect(text(await w.say("tell me about 9"))).toContain("say a number from 1 to 3");

    const skip = await w.say("skip 2");
    expect(text(skip)).toContain("Skipped 2 (Allston Green");
    expect((await w.store.listListings(w.move.id)).find((l) => l.rank === 2)?.status).toBe("rejected");
    expect(skip.events?.[0]?.type).toBe("housing.listing_rejected");

    const save = await w.say("save 1");
    expect(text(save)).toContain("Saved 1: Sunny furnished room");
    expect(text(save)).toContain("You send this; I won't contact them");
    expect(text(save)).toContain("Is it still available?");
    expect((await w.store.listListings(w.move.id)).find((l) => l.rank === 1)?.status).toBe("shortlisted");
  });

  test("reach out to a pick with a phone on the listing: the dedicated line texts the lister, then the owner hears from which line", async () => {
    const w = await world();
    const r = await w.say("looking for a room in allston under 1200 june 1 to aug 30");
    await r.later!();

    const reach = await w.say("reach out to 2"); // Allston Green shows (617) 555-0142
    expect(reach.replies).toEqual([]);
    expect(reach.outbound).toHaveLength(1);
    const note = reach.outbound![0] as ElfOutboundToHandle;
    expect(note.to).toEqual({ handle: "+16175550142", platform: "script" });
    expect(note.text).toBe(
      "Hi, I saw your listing for Allston Green, shared 4BR, private room from Jun 1 to Aug 30. My budget is $1,200 a month. Is it still available?",
    );
    const deals = await w.store.listDeals(w.move.id);
    expect(deals).toHaveLength(1);
    expect(deals[0]).toMatchObject({ mode: "find_sublet", askCents: 120000, limitCents: 120000 });
    expect(note.dealId).toBe(deals[0]!.id);
    expect(reach.events?.map((e) => e.type)).toEqual([
      "housing.listing_shortlisted",
      "deal.opened",
      "housing.lister_texted",
    ]);
    expect((await w.store.listListings(w.move.id)).find((l) => l.rank === 2)?.status).toBe("shortlisted");

    // the service reports the send; the owner's confirmation names the line and the ref
    await note.onSent!("out_1", { line: "+16285550100" });
    const told = await reach.later!();
    expect(told.replies[0]!.text).toBe(
      `Texted them from +16285550100: "${note.text}"\nRef ${deals[0]!.code}. I'll relay what they say and negotiate up to $1,200/mo.`,
    );
    await told.replies[0]!.onSent!("out_2", { line: null });
    expect((await w.store.getDeal(deals[0]!.id))?.ownerThreadId).toBe("out_2");
    expect(told.boardPatch?.lastUpdate).toContain("texted the lister");
  });

  test("reach out when the line could not text: the owner gets the note to send instead", async () => {
    const w = await world();
    const r = await w.say("looking for a room in allston under 1200 june 1 to aug 30");
    await r.later!();
    const reach = await w.say("contact 2");
    const told = await reach.later!(); // onSent never fired
    expect(told.replies[0]!.text).toContain("I couldn't text them from my line.");
    expect(told.replies[0]!.text).toContain("You send this; I won't contact them:");
    expect(told.replies[0]!.text).toContain("Ref ");
  });

  test("reach out to a pick with no phone keeps the owner as the sender", async () => {
    const w = await world();
    const r = await w.say("looking for a room in allston under 1200 june 1 to aug 30");
    await r.later!();
    const reach = await w.say("reach out to 1"); // Sunny furnished room: no contact
    expect(reach.outbound).toBeUndefined();
    expect(reach.later).toBeUndefined();
    expect(text(reach)).toContain("Saved 1: Sunny furnished room");
    expect(text(reach)).toContain("You send this; I won't contact them");
    expect(text(reach)).toContain("I still won't message them myself.");
    const deal = (await w.store.listDeals(w.move.id))[0]!;
    expect(text(reach)).toContain(`Ref ${deal.code}`);
    await reach.replies[0]!.onSent!("out_9", { line: null });
    expect((await w.store.getDeal(deal.id))?.ownerThreadId).toBe("out_9");
  });

  test("phoneHandle: US ten digits, 1-prefixed, international, and junk", () => {
    expect(phoneHandle("(617) 555-0142")).toBe("+16175550142");
    expect(phoneHandle("1-617-555-0142")).toBe("+16175550142");
    expect(phoneHandle("+44 20 7946 0958")).toBe("+442079460958");
    expect(phoneHandle("call me")).toBeNull();
    expect(phoneHandle("555-0142")).toBeNull();
    expect(phoneHandle(null)).toBeNull();
  });

  test("the same ask again within minutes re-sends the picks instead of searching", async () => {
    const w = await world();
    const r = await w.say("looking for a room in allston under 1200 june 1 to aug 30");
    await r.later!();
    const again = await w.say(
      "looking for a room in allston under 1200 june 1 to aug 30",
      new Date(now.getTime() + 60_000),
    );
    expect(again.later).toBeUndefined();
    expect(text(again)).toContain("Here's what I have so far:");
    expect((w.listings as FakeListings).calls).toHaveLength(1);
    const later = await w.say(
      "looking for a room in allston under 1200 june 1 to aug 30",
      new Date(now.getTime() + 10 * 60_000),
    );
    expect(later.later).toBeDefined();
  });

  test("search again runs a new search inside the repeat window", async () => {
    const w = await world();
    const r = await w.say("looking for a room in allston under 1200 june 1 to aug 30");
    await r.later!();
    const again = await w.say("search again", new Date(now.getTime() + 60_000));
    expect(again.later).toBeDefined();
    expect(text(again)).toContain("Checking Craigslist");
    await again.later!();
    expect((w.listings as FakeListings).calls).toHaveLength(2);
  });

  test("a forwarded link is held until the ask is complete, then ranked with the picks", async () => {
    const w = await world();
    const link = "https://boston.craigslist.org/gbs/roo/d/allston-garden-level-room/7801.html";
    const held = await w.say(`looking for a room ${link}`);
    expect(text(held)).toContain("hold onto the link");
    expect(text(held)).toContain("most you'd want to pay");
    expect((await w.store.getSearch(w.move.id))?.notes).toContain(`link:${link}`);

    await w.say("under 1200");
    const r = await w.say("june 1 to aug 30");
    const t = text(await r.later!());
    expect(t).toContain("Allston garden level room");
    expect(t).toContain(link);
    expect((w.listings as FakeListings).calls).toHaveLength(1);
  });

  test("a link after the picks is added without searching the sites again", async () => {
    const w = await world();
    const r = await w.say("looking for a room in allston under 1200 june 1 to aug 30");
    await r.later!();
    const link = "https://boston.craigslist.org/gbs/roo/d/allston-garden-level-room/7801.html";
    const added = await w.say(`what about ${link}`, new Date(now.getTime() + 60_000));
    expect(added.later).toBeDefined();
    expect(text(added)).toContain("Adding the listing you sent");
    const t = text(await added.later!());
    expect(t).toContain("Allston garden level room");
    expect((w.listings as FakeListings).calls).toHaveLength(1);
  });

  test("a short gap before move-in adds a hotel line", async () => {
    const w = await world({ moveOutAt: "2026-05-30" });
    const r = await w.say("looking for a room in allston under 1200 june 1 to aug 30");
    expect(text(r)).toContain("hotels for the May 30 to Jun 1 gap");
    const t = text(await r.later!());
    expect(t).toContain("For the gap between places for May 30: Hotel Indigo Boston Garden · $140/night");
    expect(t).toContain("https://www.booking.com/");
  });

  test("a source that will not open gets an honest reply and a blocked board row", async () => {
    const w = await world({ listings: new FakeListings({ failWith: new Error("no browser") }) });
    const r = await w.say("looking for a room in allston under 1200 june 1 to aug 30");
    const done = await r.later!();
    expect(text(done)).toContain("hit a snag");
    expect(done.boardPatch?.status).toBe("blocked");
    expect(done.events?.[0]?.type).toBe("housing.search_failed");
  });

  test("no matches offers to widen; every site failing says so", async () => {
    const empty = await world({ listings: new FakeListings({ fixtures: [] }) });
    const r = await empty.say("looking for a room in allston under 1200 june 1 to aug 30");
    expect(text(await r.later!())).toContain("Nothing matched yet");
    const down = await world({
      listings: new FakeListings({ failSites: ["craigslist", "apartments", "airbnb"] }),
    });
    const r2 = await down.say("looking for a room in allston under 1200 june 1 to aug 30");
    const done = await r2.later!();
    expect(text(done)).toContain("couldn't reach");
    expect(done.boardPatch?.status).toBe("blocked");
  });

  test("the Elf doesn't read leases; move-in starts the checklist", async () => {
    const w = await world();
    expect(text(await w.say("can I sublet my room?"))).toContain("I don't read leases");
    expect(text(await w.say("set up internet at the new place"))).toContain("What day do you move in?");
  });
});
