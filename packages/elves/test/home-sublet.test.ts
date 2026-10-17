import { describe, expect, test } from "bun:test";
import {
  type ElfContext,
  type ElfResult,
  EMPTY_CONVERSATION,
  extractSubletHeuristic,
  homeElf,
  isSubletOutIntent,
  mergePost,
  missingForPost,
  templatePost,
} from "@elves/elves";
import { FakeListings } from "@elves/listings";
import { FakeLLM } from "@elves/llm";
import type { InboundMessage } from "@elves/photon";
import { createLogger, MemoryStore, type Move, type Participant, subletPostDefaults } from "@elves/shared";

const quiet = createLogger("test", "error");
const now = new Date("2026-03-01T12:00:00Z");
const move: Move = {
  id: "mv_1",
  ownerHandle: "+1",
  ownerSpaceId: "spc_1",
  platform: "script",
  name: null,
  moveOutAt: null,
  moveInAt: null,
  fromAddress: null,
  toAddress: null,
  boardLinkSent: false,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
};

describe("sublet-out facts", () => {
  test("intent needs a sublet verb and the owner's own place", () => {
    expect(isSubletOutIntent("I want to sublet my room for $1500")).toBe(true);
    expect(isSubletOutIntent("rent out my place for the summer")).toBe(true);
    expect(isSubletOutIntent("looking for a sublet in allston")).toBe(false);
    expect(isSubletOutIntent("my room is a mess")).toBe(false);
    // questions about subletting go to the lease reader
    expect(isSubletOutIntent("can I sublet my room?")).toBe(false);
    expect(isSubletOutIntent("my landlord says i cant sublet, can you check the lease?")).toBe(false);
    expect(isSubletOutIntent("am I allowed to sublet my place")).toBe(false);
  });
  test("heuristic pulls rent, dates, area, furnished, room type and selling points", () => {
    const f = extractSubletHeuristic(
      "sublet my room in allston for $1,500/mo june 1 to aug 31, furnished, laundry in building, near the T, in a 3br",
      now,
    );
    expect(f).toMatchObject({
      rentUsd: 1500,
      availableFrom: "2026-06-01",
      availableUntil: "2026-08-31",
      area: "Allston",
      furnished: true,
      roomType: "private room in a 3BR",
      wantsToSublet: true,
    });
    expect(f.details).toEqual(["near the T", "laundry"]);
    expect(extractSubletHeuristic("it's a studio, unfurnished", now)).toMatchObject({
      roomType: "studio",
      furnished: false,
    });
  });
  test("merge borrows the move-out date and asks rent, then dates, then area", () => {
    let p = mergePost(undefined, extractSubletHeuristic("sublet my room", now), move);
    expect(missingForPost(p)).toBe("rent");
    p = mergePost(p, extractSubletHeuristic("$1500", now), move);
    expect(missingForPost(p)).toBe("dates");
    p = mergePost(p, extractSubletHeuristic("june 1 to aug 31", now), move);
    expect(missingForPost(p)).toBe("area");
    p = mergePost(p, extractSubletHeuristic("brighton", now), move);
    expect(missingForPost(p)).toBeNull();
    const withMoveOut = mergePost(undefined, extractSubletHeuristic("sublet my room for 1400", now), {
      ...move,
      moveOutAt: "2026-05-30",
    });
    expect(withMoveOut.availableFrom).toBe("2026-05-30");
    expect(missingForPost(withMoveOut)).toBe("area");
  });
  test("the template post carries every fact and the contact line", () => {
    const p = {
      ...subletPostDefaults(move.id),
      rentCents: 150000,
      availableFrom: "2026-06-01",
      availableUntil: "2026-08-31",
      area: "Allston",
      furnished: true,
      roomType: "private room in a 3BR",
      details: ["laundry", "near the T"],
      photoNotes: "Bright room with a big window and hardwood floors.",
    };
    const { title, body } = templatePost(p, "Text +1628 and mention ref K7Q2 to set up a viewing.");
    expect(title).toBe("Furnished private room in a 3BR in Allston, Jun 1 to Aug 31, $1,500/mo");
    expect(body).toContain("from Jun 1 to Aug 31. $1,500/mo, no broker fee.");
    expect(body).toContain("Laundry. Near the T. Bright room with a big window and hardwood floors.");
    expect(body.endsWith("Text +1628 and mention ref K7Q2 to set up a viewing.")).toBe(true);
  });
});

async function world(opts: { moveOutAt?: string | null } = {}) {
  const store = new MemoryStore();
  let mv = await store.createMove({ ownerHandle: "+1", ownerSpaceId: "spc_1", platform: "script" });
  if (opts.moveOutAt) mv = await store.updateMove(mv.id, { moveOutAt: opts.moveOutAt });
  const participant: Participant = await store.upsertParticipant({
    moveId: mv.id,
    handle: "+1",
    role: "owner",
    spaceId: "spc_1",
    platform: "script",
    agentUserId: "usr_agent",
  });
  const llm = new FakeLLM();
  let seq = 0;
  const say = async (text: string | null, attachments: { id: string }[] = []): Promise<ElfResult> => {
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
      attachments,
      reaction: null,
      parentMessageId: null,
      receivedAt: now.toISOString(),
    };
    const ctx: ElfContext = {
      store,
      llm,
      move: fresh,
      participant,
      batch: { spaceId: "spc_1", messages: [m], traceId: "t", carried: 0 },
      traceId: "t",
      log: quiet,
      signal: new AbortController().signal,
      publicUrl: null,
      firstContact: false,
      now: () => now,
      fetchAttachment: async (id) =>
        id === "att_room"
          ? { id, bytes: new Uint8Array([0xff, 0xd8, 0xff]), contentType: "image/jpeg", filename: "room.jpg" }
          : null,
      conversation: EMPTY_CONVERSATION,
      listings: new FakeListings(),
    };
    return homeElf.handle(ctx);
  };
  return { store, move: mv, say, llm };
}

const text = (r: ElfResult) => r.replies.map((x) => x.text).join("\n");

describe("Home Elf: subletting the owner's room", () => {
  test("rent opens the deal at once; dates and area come one at a time; then the post", async () => {
    const w = await world();
    const r1 = await w.say("I want to sublet my room for $1500");
    expect(text(r1)).toContain("Listed your room at $1,500/mo (ref ");
    expect(text(r1)).toContain("When is it free from, and until when?");
    const deal = (await w.store.listDeals(w.move.id)).find((d) => d.mode === "sublet_out");
    expect(deal?.limitCents).toBe(150000);
    expect((await w.store.getSubletPost(w.move.id))?.dealId).toBe(deal?.id ?? null);

    const r2 = await w.say("june 1 to aug 31");
    expect(text(r2)).toContain("Which neighborhood or street");
    expect(text(r2)).not.toContain("Listed your room");

    const r3 = await w.say("it's in allston, furnished, laundry in the building");
    const post = (await w.store.getSubletPost(w.move.id))!;
    expect(post.status).toBe("drafted");
    expect(text(r3)).toContain("Here's the post:");
    expect(text(r3)).toContain("Furnished private room in Allston, Jun 1 to Aug 31, $1,500/mo");
    expect(text(r3)).toContain(`Text +1628 and mention ref ${deal?.code} to set up a viewing.`);
    expect(text(r3)).toContain("Paste that on Craigslist");
    expect(r3.events?.map((e) => e.type)).toContain("sublet.post_drafted");
  });

  test("room photos are described into the post; edits redraft; 'post it' approves", async () => {
    const w = await world({ moveOutAt: "2026-06-01" });
    await w.say("sublet my room in brighton for $1200 until aug 31");
    const drafted = (await w.store.getSubletPost(w.move.id))!;
    expect(drafted.status).toBe("drafted");
    expect(drafted.availableFrom).toBe("2026-06-01");

    w.llm.visionResult = {
      roomType: "private bedroom",
      furnished: true,
      features: ["big window", "closet", "desk"],
      condition: "good",
      summary: "Bright bedroom with a big window, a closet and a desk.",
    };
    const r = await w.say(null, [{ id: "att_room" }]);
    expect(text(r)).toContain("Got the photo: Bright bedroom with a big window, a closet and a desk.");
    const withPhoto = (await w.store.getSubletPost(w.move.id))!;
    expect(withPhoto.photoAttachmentIds).toEqual(["att_room"]);
    expect(withPhoto.details).toEqual(expect.arrayContaining(["big window", "closet", "desk"]));
    expect(withPhoto.body).toContain("Bright bedroom with a big window");

    const edited = await w.say("mention that the porch is shared");
    expect(text(edited)).toContain("(mention that the porch is shared)");
    expect((await w.store.getSubletPost(w.move.id))?.status).toBe("drafted");

    const ok = await w.say("post it");
    expect(text(ok)).toContain("that's the post");
    expect((await w.store.getSubletPost(w.move.id))?.status).toBe("approved");
    expect(ok.events?.[0]?.type).toBe("sublet.post_approved");

    // after approval, a hunt text is a hunt again
    const hunt = await w.say("find me a room in allston under 1200");
    expect(text(hunt)).toContain("When do you need it");
  });

  test("a hunt text while a post is collecting is still a hunt", async () => {
    const w = await world();
    await w.say("sublet my room");
    expect((await w.store.getSubletPost(w.move.id))?.status).toBe("collecting");
    const r = await w.say("looking for a room in allston under 1200 june 1 to aug 30");
    expect(r.later).toBeDefined();
  });
});
