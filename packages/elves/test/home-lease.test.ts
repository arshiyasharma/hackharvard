import { describe, expect, test } from "bun:test";
import {
  answerLeaseQuestion,
  draftLandlordNotice,
  type ElfContext,
  type ElfResult,
  EMPTY_CONVERSATION,
  homeElf,
  isLeaseQuestion,
  type LeaseReading,
  summarizeLease,
} from "@elves/elves";
import { FakeListings } from "@elves/listings";
import { FakeLLM } from "@elves/llm";
import type { InboundMessage } from "@elves/photon";
import { createLogger, MemoryStore, type Move, type Participant } from "@elves/shared";

const quiet = createLogger("test", "error");
const now = new Date("2026-03-01T12:00:00Z");

const READING: LeaseReading = {
  leaseEnd: "2026-08-31",
  monthlyRentUsd: 2400,
  depositUsd: 2400,
  depositReturnDays: 30,
  sublet: "with_consent",
  subletClause: { quote: "Tenant shall not sublet without the prior written consent of Landlord.", page: 4 },
  noticeDays: 30,
  noticeClause: { quote: "Either party may terminate with thirty (30) days written notice.", page: 2 },
  earlyTermination: null,
  landlord: { name: "Park Street Realty", email: "leases@parkstreet.example", phone: null, address: null },
  propertyAddress: "12 Oak St Apt 2, Allston, MA",
  tenants: ["Gavin Z."],
  flags: ["professional cleaning required at move-out", "return 2 keys and the fob"],
};

describe("lease reading", () => {
  test("the summary quotes the clauses with pages and ends with the next step", () => {
    const s = summarizeLease(READING, "lease.pdf");
    expect(s).toContain("Read your lease (lease.pdf).");
    expect(s).toContain(
      "Subletting: allowed with the landlord's written consent — \"Tenant shall not sublet",
    );
    expect(s).toContain("(p. 4)");
    expect(s).toContain("Notice: 30 days written notice");
    expect(s).toContain(
      "Lease ends Aug 31; rent $2,400/mo; deposit $2,400, back within 30 days of move-out.",
    );
    expect(s).toContain("Also: professional cleaning required at move-out; return 2 keys and the fob.");
    expect(s).toContain('"ask the landlord" for the sublet request');
  });
  test("questions are answered from the reading; silence is honest", () => {
    expect(answerLeaseQuestion(READING, "can I sublet my room?")).toContain(
      "Only with the landlord's written consent",
    );
    expect(answerLeaseQuestion(READING, "how much notice do I need to give")).toContain(
      "30 days written notice",
    );
    expect(answerLeaseQuestion(READING, "when do I get my deposit back")).toContain("within 30 days");
    expect(answerLeaseQuestion(READING, "when does the lease end")).toBe("Your lease ends Aug 31.");
    expect(answerLeaseQuestion(READING, "can I break the lease early")).toContain("doesn't spell out");
    expect(answerLeaseQuestion({ ...READING, noticeDays: null, noticeClause: null }, "notice?")).toBeNull();
    expect(isLeaseQuestion("my landlord needs 30 days notice")).toBe(true);
    expect(isLeaseQuestion("looking for a room in allston")).toBe(false);
  });
  test("the landlord notice carries the move-out date, the notice clause and the deposit", () => {
    const move = { fromAddress: null, moveOutAt: "2026-08-31", name: null } as Move;
    const n = draftLandlordNotice(READING, move, "+1");
    expect(n).toContain("To: Park Street Realty <leases@parkstreet.example>");
    expect(n).toContain("Subject: Notice to vacate 12 Oak St Apt 2, Allston, MA");
    expect(n).toContain(
      "vacate 12 Oak St Apt 2, Allston, MA on Aug 31. This meets the 30-day notice in the lease (p. 2).",
    );
    expect(n).toContain("return my $2,400 security deposit within 30 days");
  });
});

async function world(opts: { firstContact?: boolean } = {}) {
  const store = new MemoryStore();
  const mv = await store.createMove({ ownerHandle: "+1", ownerSpaceId: "spc_1", platform: "script" });
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
  const say = async (
    text: string | null,
    attachments: { id: string; mimeType?: string; name?: string }[] = [],
    firstContact = opts.firstContact ?? false,
  ): Promise<ElfResult> => {
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
      firstContact,
      now: () => now,
      fetchAttachment: async (id) =>
        id === "att_lease"
          ? {
              id,
              bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
              contentType: "application/pdf",
              filename: "lease.pdf",
            }
          : null,
      conversation: EMPTY_CONVERSATION,
      listings: new FakeListings(),
    };
    return homeElf.handle(ctx);
  };
  return { store, move: mv, say, llm };
}

const text = (r: ElfResult) => r.replies.map((x) => x.text).join("\n");

describe("Home Elf: the lease", () => {
  test("a PDF is read, stored, summarized; questions and the notice come from the reading", async () => {
    const w = await world();
    w.llm.documentResult = READING;
    const r1 = await w.say("here's my lease", [
      { id: "att_lease", mimeType: "application/pdf", name: "lease.pdf" },
    ]);
    expect(text(r1)).toContain("Read your lease (lease.pdf)");
    expect(text(r1)).toContain("(p. 4)");
    expect(r1.events?.[0]).toMatchObject({
      type: "lease.read",
      payload: { sublet: "with_consent", noticeDays: 30 },
    });
    expect(r1.movePatch?.fromAddress).toBe("12 Oak St Apt 2, Allston, MA");
    expect((await w.store.getLeaseReading(w.move.id))?.attachmentId).toBe("att_lease");

    expect(text(await w.say("can i sublet my room?"))).toContain("Only with the landlord's written consent");
    expect(text(await w.say("how much notice do i owe"))).toContain("30 days written notice");

    await w.store.updateMove(w.move.id, { moveOutAt: "2026-08-31" });
    const notice = await w.say("draft the notice to my landlord");
    expect(text(notice)).toContain("Here's your move-out notice. You send it; I don't:");
    expect(text(notice)).toContain("Subject: Notice to vacate 12 Oak St Apt 2, Allston, MA");
    expect(notice.events?.[0]?.type).toBe("lease.notice_drafted");

    const ask = await w.say("ask the landlord if I can sublet");
    expect(text(ask)).toContain("Subject: Request to sublet");
  });

  test("without a reading, a lease question still gets the canned ask for the PDF", async () => {
    const w = await world();
    expect(text(await w.say("can i sublet my room?"))).toContain("Send the lease PDF");
  });

  test("an unreadable PDF gets an honest ask; a PDF on first contact greets as the crew", async () => {
    const w = await world({ firstContact: true });
    const bad = await w.say(null, [{ id: "missing", mimeType: "application/pdf" }]);
    expect(text(bad)).toContain("couldn't read that PDF");
    w.llm.documentResult = READING;
    const ok = await w.say(null, [{ id: "att_lease", mimeType: "application/pdf" }]);
    expect(text(ok).startsWith("Hey, this is your moving crew. Read your lease")).toBe(true);
  });
});
