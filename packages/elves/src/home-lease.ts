import type { LeaseReading as LeaseRecord, Move } from "@elves/shared";
import { z } from "zod";
import { type ElfContext, type ElfResult, isDocumentAttachment, memoryPreamble } from "./contract.ts";
import { formatDate } from "./facts.ts";

/**
 * The owner's lease, read once from the PDF and kept on the move: can they sublet, how much notice, what
 * happens to the deposit, with the clauses quoted. The Elf answers from the reading and drafts the landlord
 * notice; it never sends anything and never gives legal advice beyond what the lease says.
 */

const Clause = z.object({
  quote: z.string().describe("the clause's own words, 40 words at most"),
  page: z.number().nullable().describe("page number the clause is on, or null"),
});

export const LeaseReading = z.object({
  leaseEnd: z.string().nullable().describe("ISO date the lease term ends"),
  monthlyRentUsd: z.number().nullable(),
  depositUsd: z.number().nullable(),
  depositReturnDays: z
    .number()
    .nullable()
    .describe("days after move-out the deposit must be returned, when the lease or the law it cites says"),
  sublet: z
    .enum(["allowed", "with_consent", "prohibited", "unclear"])
    .describe("what the lease says about subletting or assigning"),
  subletClause: Clause.nullable(),
  noticeDays: z.number().nullable().describe("days of written notice to end or not renew"),
  noticeClause: Clause.nullable(),
  earlyTermination: z.string().nullable().describe("what leaving early costs, in the lease's words, or null"),
  landlord: z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    address: z.string().nullable(),
  }),
  propertyAddress: z.string().nullable(),
  tenants: z.array(z.string()),
  flags: z.array(z.string()).describe("short things a tenant moving out should know: cleaning, keys, fees"),
});
export type LeaseReading = z.infer<typeof LeaseReading>;

const READ_SYSTEM =
  "You read a residential lease for a tenant who is moving out and may want to sublet. Pull out only what the " +
  "document says; quote clauses in their own words with the page number; use null when the lease is silent. " +
  "Do not infer rights the lease does not state.";

const LEASE_QUESTION =
  /\b(sublet|sublease|assign|notice|deposit|lease|landlord|break (?:the|my) lease|terminate|early|move[- ]?out date|when does (?:it|the lease) end|clause)\b/i;
const NOTICE_REQUEST =
  /\b(draft|write|send|prepare)\b.*\b(notice|letter|email)\b|\bnotice (?:to|for) (?:the |my )?landlord\b|\blandlord notice\b/i;
const SUBLET_REQUEST =
  /\b(draft|write)\b.*\b(sublet|consent) (?:request|letter|email)\b|\bask (?:the |my )?landlord\b/i;

export function isLeaseQuestion(text: string): boolean {
  return LEASE_QUESTION.test(text);
}

const PERMISSION_QUESTION =
  /\b(?:can|could|may|am i|allowed|able|ok)\b[^.?!]{0,40}\b(?:sublet|sublease|assign|break(?: the| my)? lease|terminate)\b|\bcheck (?:the|my) lease\b|\b(?:landlord|lease) says?\b/i;

/** "can I sublet?", "check the lease": only the lease can answer, so without one the Elf asks for the PDF. */
export function isLeasePermissionQuestion(text: string): boolean {
  return PERMISSION_QUESTION.test(text);
}

function usd(n: number | null): string {
  return n == null ? "?" : `$${n.toLocaleString("en-US")}`;
}

function clauseRef(c: { page: number | null } | null): string {
  return c?.page != null ? ` (p. ${c.page})` : "";
}

/** The reading as the owner should hear it: one line per thing that matters, clause quoted. */
export function summarizeLease(r: LeaseReading, filename: string | null): string {
  const lines: string[] = [`Read your lease${filename ? ` (${filename})` : ""}. What matters for the move:`];
  const subletWord =
    r.sublet === "allowed"
      ? "allowed"
      : r.sublet === "with_consent"
        ? "allowed with the landlord's written consent"
        : r.sublet === "prohibited"
          ? "not allowed"
          : "not addressed";
  lines.push(
    `Subletting: ${subletWord}${r.subletClause ? ` — "${r.subletClause.quote}"${clauseRef(r.subletClause)}` : ""}.`,
  );
  if (r.noticeDays != null || r.noticeClause)
    lines.push(
      `Notice: ${r.noticeDays != null ? `${r.noticeDays} days written notice` : "see the clause"}${r.noticeClause ? ` — "${r.noticeClause.quote}"${clauseRef(r.noticeClause)}` : ""}.`,
    );
  const term: string[] = [];
  if (r.leaseEnd) term.push(`lease ends ${formatDate(r.leaseEnd)}`);
  if (r.monthlyRentUsd != null) term.push(`rent ${usd(r.monthlyRentUsd)}/mo`);
  if (r.depositUsd != null)
    term.push(
      `deposit ${usd(r.depositUsd)}${r.depositReturnDays != null ? `, back within ${r.depositReturnDays} days of move-out` : ""}`,
    );
  if (term.length) lines.push(`${term.join("; ").replace(/^./, (c) => c.toUpperCase())}.`);
  if (r.earlyTermination) lines.push(`Leaving early: ${r.earlyTermination}.`);
  if (r.flags.length) lines.push(`Also: ${r.flags.join("; ")}.`);
  lines.push(
    r.sublet === "prohibited"
      ? 'Say "draft the notice" and I\'ll write your move-out notice to the landlord.'
      : 'Say "draft the notice" for the move-out notice, or "ask the landlord" for the sublet request. You send it; I don\'t.',
  );
  return lines.join("\n");
}

/** One lease question, answered from the reading. Null when the reading has nothing on it. */
export function answerLeaseQuestion(r: LeaseReading, text: string): string | null {
  const t = text.toLowerCase();
  if (/\b(sublet|sublease|assign)\b/.test(t)) {
    const word =
      r.sublet === "allowed"
        ? "Yes, your lease allows subletting"
        : r.sublet === "with_consent"
          ? "Only with the landlord's written consent"
          : r.sublet === "prohibited"
            ? "No, your lease does not allow subletting"
            : "Your lease doesn't address subletting; ask the landlord in writing";
    return `${word}${r.subletClause ? `: "${r.subletClause.quote}"${clauseRef(r.subletClause)}` : ""}.`;
  }
  if (/\bnotice\b/.test(t)) {
    if (r.noticeDays == null && !r.noticeClause) return null;
    return `${r.noticeDays != null ? `${r.noticeDays} days written notice` : "See the notice clause"}${r.noticeClause ? `: "${r.noticeClause.quote}"${clauseRef(r.noticeClause)}` : ""}.`;
  }
  if (/\bdeposit\b/.test(t)) {
    if (r.depositUsd == null && r.depositReturnDays == null) return null;
    return `Deposit ${usd(r.depositUsd)}${r.depositReturnDays != null ? `, due back within ${r.depositReturnDays} days of move-out` : ""}. Leave the place clean, photograph every room, and hand in the keys in writing.`;
  }
  if (/\b(end|ends|expire|term)\b/.test(t) && r.leaseEnd) return `Your lease ends ${formatDate(r.leaseEnd)}.`;
  if (/\b(break|terminate|early)\b/.test(t))
    return r.earlyTermination
      ? `Leaving early: ${r.earlyTermination}.`
      : "Your lease doesn't spell out an early-exit cost; the notice clause is what applies.";
  return null;
}

/** The move-out notice the owner sends. Plain text, every fact from the lease or the move. */
export function draftLandlordNotice(r: LeaseReading, move: Move, owner: string): string {
  const to = r.landlord.name ?? "Landlord";
  const where = r.propertyAddress ?? move.fromAddress ?? "the apartment";
  const when = move.moveOutAt
    ? formatDate(move.moveOutAt)
    : r.leaseEnd
      ? formatDate(r.leaseEnd)
      : "[move-out date]";
  const notice =
    r.noticeDays != null
      ? ` This meets the ${r.noticeDays}-day notice in the lease${clauseRef(r.noticeClause)}.`
      : "";
  const deposit =
    r.depositUsd != null
      ? ` Please return my ${usd(r.depositUsd)} security deposit${r.depositReturnDays != null ? ` within ${r.depositReturnDays} days` : ""} to the address I'll send separately.`
      : "";
  return [
    `To: ${to}${r.landlord.email ? ` <${r.landlord.email}>` : ""}`,
    `Subject: Notice to vacate ${where}`,
    "",
    `Dear ${to},`,
    "",
    `This is my written notice that I will vacate ${where} on ${when}.${notice} I'll leave the unit clean and return all keys that day; please let me know when you'd like to do the move-out walkthrough.${deposit}`,
    "",
    "Thank you,",
    owner,
  ].join("\n");
}

/** The sublet consent request the owner sends. */
export function draftSubletRequest(r: LeaseReading, move: Move, owner: string): string {
  const to = r.landlord.name ?? "Landlord";
  const where = r.propertyAddress ?? move.fromAddress ?? "the apartment";
  const from = move.moveOutAt ? formatDate(move.moveOutAt) : "[start]";
  const until = r.leaseEnd ? formatDate(r.leaseEnd) : "[lease end]";
  return [
    `To: ${to}${r.landlord.email ? ` <${r.landlord.email}>` : ""}`,
    `Subject: Request to sublet ${where}`,
    "",
    `Dear ${to},`,
    "",
    `I'm writing to ask for your written consent to sublet ${where} from ${from} to ${until}${r.subletClause ? `, as the lease provides${clauseRef(r.subletClause)}` : ""}. I'll remain responsible for the rent and the condition of the unit, and I'll share the subtenant's name and references for your approval before anyone moves in.`,
    "",
    "Thank you,",
    owner,
  ].join("\n");
}

async function readLeasePdf(
  ctx: ElfContext,
): Promise<{ id: string; filename: string | null; reading: LeaseReading } | null> {
  const doc = ctx.batch.messages.flatMap((m) => m.attachments).find(isDocumentAttachment);
  if (!doc) return null;
  const file = await ctx.fetchAttachment(doc.id);
  if (!file) throw new Error(`attachment ${doc.id} not available`);
  const reading = await ctx.llm.extractFromDocument(LeaseReading, {
    system: READ_SYSTEM,
    user: `The tenant sent their lease${file.filename ? ` (${file.filename})` : ""}. Today is ${ctx.now().toISOString().slice(0, 10)}. Read it for them.`,
    document: { mediaType: "application/pdf", base64: Buffer.from(file.bytes).toString("base64") },
  });
  return { id: doc.id, filename: file.filename ?? doc.name ?? null, reading };
}

function parseStored(rec: LeaseRecord | undefined): LeaseReading | null {
  if (!rec) return null;
  const parsed = LeaseReading.safeParse(rec.reading);
  return parsed.success ? parsed.data : null;
}

/**
 * The owner's side of the lease: a PDF in the batch is read and summarized; a lease question or a "draft the
 * notice" is answered from the stored reading. Null when there is nothing lease-related to do here.
 */
export async function handleLease(ctx: ElfContext, text: string, parent: string): Promise<ElfResult | null> {
  const reply = (body: string, extra: Partial<ElfResult> = {}): ElfResult => ({
    replies: [{ text: body, parentMessageId: parent }],
    ...extra,
  });
  const hasPdf = ctx.batch.messages.some((m) => m.attachments.some(isDocumentAttachment));
  if (hasPdf) {
    let read: Awaited<ReturnType<typeof readLeasePdf>>;
    try {
      read = await readLeasePdf(ctx);
    } catch (err) {
      ctx.log.warn("lease read failed", { error: String(err) });
      return reply("I couldn't read that PDF. Can you send it again, or photos of the pages?", {
        boardPatch: { status: "blocked", currentTask: "Reading the lease", lastUpdate: "PDF unreadable" },
      });
    }
    if (!read) return null;
    await ctx.store.saveLeaseReading({
      moveId: ctx.move.id,
      attachmentId: read.id,
      filename: read.filename,
      reading: read.reading,
    });
    const movePatch: ElfResult["movePatch"] = {};
    if (read.reading.propertyAddress && !ctx.move.fromAddress)
      movePatch.fromAddress = read.reading.propertyAddress;
    const greeting = ctx.firstContact ? "Hey, this is your moving crew. " : "";
    const summary = summarizeLease(read.reading, read.filename);
    return reply(greeting ? `${greeting}${summary}` : summary, {
      movePatch,
      events: [
        {
          type: "lease.read",
          payload: {
            attachmentId: read.id,
            sublet: read.reading.sublet,
            noticeDays: read.reading.noticeDays,
            leaseEnd: read.reading.leaseEnd,
          },
        },
      ],
      boardPatch: {
        status: "working",
        currentTask: "Lease read",
        lastUpdate: `Sublet ${read.reading.sublet.replace("_", " ")}${read.reading.noticeDays != null ? `, ${read.reading.noticeDays}-day notice` : ""}`,
      },
    });
  }

  const stored = parseStored(await ctx.store.getLeaseReading(ctx.move.id));
  if (!stored) return null;
  const owner = ctx.move.name ?? ctx.participant.handle;
  if (SUBLET_REQUEST.test(text)) {
    return reply(
      `Here's the sublet request. You send it; I don't:\n\n${draftSubletRequest(stored, ctx.move, owner)}`,
      {
        events: [{ type: "lease.sublet_request_drafted", payload: {} }],
        boardPatch: { status: "working", lastUpdate: "Sublet request drafted" },
      },
    );
  }
  if (NOTICE_REQUEST.test(text)) {
    const draft = await voiceNotice(ctx, draftLandlordNotice(stored, ctx.move, owner));
    return reply(`Here's your move-out notice. You send it; I don't:\n\n${draft}`, {
      events: [{ type: "lease.notice_drafted", payload: { moveOutAt: ctx.move.moveOutAt } }],
      boardPatch: { status: "working", lastUpdate: "Landlord notice drafted" },
    });
  }
  if (isLeaseQuestion(text)) {
    const answer = answerLeaseQuestion(stored, text);
    if (answer)
      return reply(answer, { boardPatch: { status: "working", lastUpdate: "Answered from the lease" } });
  }
  return null;
}

/** The model may smooth the notice's wording; every date, dollar amount and page reference stays. */
async function voiceNotice(ctx: ElfContext, template: string): Promise<string> {
  if (ctx.llm.name === "fake") return template;
  try {
    const draft = await ctx.llm.draft({
      system:
        "You polish a tenant's move-out notice to their landlord. Plain text, same structure (To, Subject, greeting, " +
        "one or two short paragraphs, sign-off). Keep every date, dollar amount, address and page reference exactly. " +
        "Do not add promises or legal claims.",
      user: `${memoryPreamble(ctx.conversation)}\n\nDraft:\n${template}\n\nReturn the polished notice.`,
      maxTokens: 400,
    });
    const same = (s: string) =>
      (s.match(/\$[\d,]+|\b\d{1,2}-day\b|p\. \d+|[A-Z][a-z]{2} \d{1,2}\b/g) ?? []).sort().join("|");
    return draft && same(draft) === same(template) ? draft : template;
  } catch (err) {
    ctx.log.warn("notice draft failed; using template", { error: String(err) });
    return template;
  }
}
