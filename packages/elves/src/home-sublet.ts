import { openDeal } from "@elves/engine";
import type { Move, SubletPost } from "@elves/shared";
import { subletPostDefaults } from "@elves/shared";
import { z } from "zod";
import { type ElfContext, type ElfResult, hasPhotos, memoryPreamble } from "./contract.ts";
import { formatDate, parseDateRange } from "./facts.ts";
import { extractHousingHeuristic, parseBudgetCents, parseNeighborhoods } from "./home-facts.ts";
import { fmtPrice } from "./home-rank.ts";
import { isApproval, loadBatchImages } from "./intake.ts";

/**
 * Subletting the owner's own room: collect rent, dates and area one thing at a time, read the room photos,
 * open the sublet_out deal as soon as there is a rent, and write the post the owner pastes on Craigslist or
 * Facebook. Applicants text the number with the ref code and the Deal Engine takes it from there.
 */

export const SubletFacts = z.object({
  rentUsd: z.number().nullable().describe("monthly rent the owner wants, whole dollars"),
  availableFrom: z.string().nullable().describe("ISO YYYY-MM-DD the room is free from"),
  availableUntil: z.string().nullable().describe("ISO YYYY-MM-DD the sublet ends (lease end), or null"),
  area: z.string().nullable().describe("neighborhood or street the room is in"),
  furnished: z.boolean().nullable(),
  roomType: z
    .string()
    .nullable()
    .describe("'private room in a 3BR', 'studio', '1BR apartment', as the owner describes it"),
  details: z.array(z.string()).describe("short selling points the owner mentioned: 'laundry in building'"),
  wantsToSublet: z
    .boolean()
    .describe("true when the owner is asking the crew to sublet or rent out their place"),
});
export type SubletFacts = z.infer<typeof SubletFacts>;

const SUBLET_VERB = /\b(sublet|sublease|rent out|list|lease out)\b/i;
const OWN_PLACE =
  /\b(my (?:room|place|apartment|apt|bedroom|studio|lease|unit)|our (?:place|apartment|apt))\b/i;

/** "sublet my room", "rent out my place": the owner wants their own room listed. */
export function isSubletOutIntent(text: string): boolean {
  return SUBLET_VERB.test(text) && OWN_PLACE.test(text) && !ASKING_ABOUT.test(text);
}

/** "can I sublet my room?" or "check the lease" is a question for the lease reader, not a listing. */
const ASKING_ABOUT =
  /^\s*(?:can|could|may|should|am i|is it|does|do i|what|how|when|is|are)\b|\b(?:allowed to|able to|can i|could i|am i allowed|is it ok|check (?:the|my) lease|lease says?|landlord says?)\b/i;

const DETAIL_WORDS: [RegExp, string][] = [
  [/\bnear (?:the )?(?:t|train|red line|green line|orange line|blue line|b line|subway)\b/i, "near the T"],
  [/\bparking\b/i, "parking"],
  [/\b(?:in[- ]unit )?laundry\b/i, "laundry"],
  [/\b(?:cats?|dogs?|pets?) ?(?:ok|friendly|allowed)\b/i, "pets ok"],
  [/\bprivate bath(?:room)?\b/i, "private bathroom"],
  [/\butilities included\b/i, "utilities included"],
  [/\bquiet\b/i, "quiet street"],
  [/\bbig window|lots of light|sunny|bright\b/i, "lots of light"],
  [/\bbalcony|porch\b/i, "porch"],
  [/\bdishwasher\b/i, "dishwasher"],
  [/\bac\b|air ?conditioning/i, "AC"],
];

const ROOM_TYPES: [RegExp, string][] = [
  [/\bstudio\b/i, "studio"],
  [/\b(?:1 ?br|one[- ]bedroom|1[- ]bed(?:room)?)\b/i, "1BR apartment"],
  [/\b(?:2 ?br|two[- ]bedroom|2[- ]bed(?:room)?)\b/i, "2BR apartment"],
  [/\bprivate room|my (?:bed)?room\b/i, "private room"],
];

const IN_A_SHARE = /\bin a (\d)\s?(?:br|bed(?:room)?)\b|\bwith (\d|two|three|four) roommates?\b/i;

/** Deterministic extraction, used with the fake LLM and as a safety net beside the real one. */
const RENT_FOR =
  /\b(?:for|at|asking)\s*\$?\s?(\d{1,2},?\d{3}|\d{3,5})\b(?!\s*(?:nights?|days?|people|roommates?))/i;
const BARE_RENT = /^\s*\$?\s?(\d{1,2},?\d{3}|\d{3,5})\s*(?:\/|per|a)?\s*(?:mo|month)?\s*[.!]?\s*$/i;

/** "for 1400", "at $1,500", or a bare "1500" in answer to the rent question. */
export function parseRentCents(text: string): number | null {
  const direct = parseBudgetCents(text);
  if (direct != null) return direct;
  const m = text.match(RENT_FOR) ?? text.match(BARE_RENT);
  if (!m?.[1]) return null;
  const usd = Number(m[1].replace(/,/g, ""));
  return usd >= 300 && usd <= 20000 ? usd * 100 : null;
}

export function extractSubletHeuristic(text: string, now: Date): SubletFacts {
  const rent = parseRentCents(text);
  const range = parseDateRange(text, now);
  const roomType = ROOM_TYPES.find(([re]) => re.test(text))?.[1] ?? null;
  const share = text.match(IN_A_SHARE);
  const shareN = share
    ? (share[1] ?? { two: "2", three: "3", four: "4" }[share[2]?.toLowerCase() ?? ""])
    : null;
  return {
    rentUsd: rent != null ? rent / 100 : null,
    availableFrom: range.start,
    availableUntil: range.end,
    area: parseNeighborhoods(text)[0] ?? null,
    furnished: /\bunfurnished\b/i.test(text) ? false : /\bfurnished\b/i.test(text) ? true : null,
    roomType: roomType && shareN && roomType === "private room" ? `private room in a ${shareN}BR` : roomType,
    details: DETAIL_WORDS.filter(([re]) => re.test(text)).map(([, label]) => label),
    wantsToSublet: isSubletOutIntent(text),
  };
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

/** This turn's facts over the saved post: scalars override, lists union, the move's dates fill gaps. */
export function mergePost(
  prev: SubletPost | Omit<SubletPost, "updatedAt"> | undefined,
  facts: SubletFacts,
  move: Move,
): Omit<SubletPost, "updatedAt"> {
  const base = prev ?? subletPostDefaults(move.id);
  return {
    ...base,
    rentCents: facts.rentUsd != null ? Math.round(facts.rentUsd * 100) : base.rentCents,
    availableFrom: facts.availableFrom ?? base.availableFrom ?? move.moveOutAt,
    availableUntil: facts.availableUntil ?? base.availableUntil,
    area: facts.area ?? base.area,
    furnished: facts.furnished ?? base.furnished,
    roomType: facts.roomType ?? base.roomType,
    details: uniq([...base.details, ...facts.details]),
  };
}

export type MissingForPost = "rent" | "dates" | "area";

/** The one thing to ask for next, or null when the post can be written. */
export function missingForPost(p: Omit<SubletPost, "updatedAt">): MissingForPost | null {
  if (p.rentCents == null) return "rent";
  if (!p.availableFrom) return "dates";
  if (!p.area) return "area";
  return null;
}

export const RoomDescription = z.object({
  roomType: z.string().nullable().describe("'private bedroom', 'studio', 'living room' as seen"),
  furnished: z.boolean().nullable(),
  features: z
    .array(z.string())
    .describe("short selling points visible: 'big window', 'closet', 'desk', 'hardwood floors'"),
  condition: z.enum(["great", "good", "fair", "rough"]),
  summary: z.string().describe("one honest, friendly sentence a listing could use"),
});
export type RoomDescription = z.infer<typeof RoomDescription>;

/** What the room photos show, for the post. Null when there are no readable photos. */
export async function describeRoomPhotos(
  ctx: ElfContext,
): Promise<{ ids: string[]; description: RoomDescription | null; failed: number }> {
  if (!hasPhotos(ctx.batch)) return { ids: [], description: null, failed: 0 };
  const { images, failed } = await loadBatchImages(ctx, 6);
  if (!images.length || ctx.signal.aborted) return { ids: [], description: null, failed };
  try {
    const description = await ctx.llm.extractFromImages(RoomDescription, {
      system:
        "You describe a room for a sublet listing from the owner's photos. Be concrete about light, floors, " +
        "furniture and storage; say what kind of room it is and whether it looks furnished. Honest and friendly; " +
        "never invent what is not visible.",
      user: `The owner sent ${images.length} photo(s) of the room they are subletting. Describe it for the listing.`,
      images: images.map(({ mediaType, base64 }) => ({ mediaType, base64 })),
    });
    return { ids: images.map((i) => i.id), description, failed };
  } catch (err) {
    ctx.log.warn("room photos: vision failed", { error: String(err) });
    return { ids: images.map((i) => i.id), description: null, failed: failed + images.length };
  }
}

const PostDraft = z.object({
  title: z.string().describe("listing title under 70 characters"),
  body: z.string().describe("60 to 120 words, plain text, paragraphs separated by blank lines"),
});

const POST_SYSTEM = `You write a sublet listing the owner will paste on Craigslist or Facebook Marketplace.
- Plain text. Title under 70 characters. Body 60 to 120 words, two or three short paragraphs.
- Use only the facts given: never invent square footage, amenities, roommates, rules or prices.
- Lead with what and where, then dates and rent, then what makes it nice, then how to reach us.
- End the body with the contact line exactly as given.`;

/** The post without a model: every fact in a fixed order, nothing invented. */
export function templatePost(
  p: Omit<SubletPost, "updatedAt">,
  contactLine: string,
): { title: string; body: string } {
  const what = p.roomType ?? "room";
  const furnished = p.furnished ? "Furnished " : p.furnished === false ? "Unfurnished " : "";
  const dates = p.availableFrom
    ? `${formatDate(p.availableFrom)}${p.availableUntil ? ` to ${formatDate(p.availableUntil)}` : " onward"}`
    : "dates flexible";
  const rent = p.rentCents != null ? fmtPrice(p.rentCents, "month") : "rent TBD";
  const title = `${furnished}${what} in ${p.area ?? "Boston"}, ${dates}, ${rent}`.slice(0, 70);
  const facts = [...p.details, ...(p.photoNotes ? [p.photoNotes.replace(/\.$/, "")] : [])];
  const body = [
    `${furnished}${what} available in ${p.area ?? "Boston"} ${p.availableFrom ? `from ${dates}` : "(dates flexible)"}. ${rent}, no broker fee.`,
    facts.length ? `${facts.map((f) => f.charAt(0).toUpperCase() + f.slice(1)).join(". ")}.` : "",
    contactLine,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { title, body };
}

/** Draft the post with the model when there is one, keeping the contact line verbatim; template otherwise. */
export async function draftPost(
  ctx: ElfContext,
  p: Omit<SubletPost, "updatedAt">,
  contactLine: string,
  instruction: string | null,
): Promise<{ title: string; body: string }> {
  const template = templatePost(p, contactLine);
  if (ctx.llm.name === "fake") {
    return instruction ? { ...template, body: `${template.body}\n\n(${instruction})` } : template;
  }
  try {
    const facts = {
      roomType: p.roomType,
      area: p.area,
      availableFrom: p.availableFrom,
      availableUntil: p.availableUntil,
      rent: p.rentCents != null ? fmtPrice(p.rentCents, "month") : null,
      furnished: p.furnished,
      details: p.details,
      photoNotes: p.photoNotes,
      contactLine,
    };
    const out = await ctx.llm.extract(PostDraft, {
      system: POST_SYSTEM,
      user: `${memoryPreamble(ctx.conversation)}\n\nFacts (JSON):\n${JSON.stringify(facts)}${
        instruction ? `\n\nThe owner asked for this change: "${instruction}"` : ""
      }${p.body ? `\n\nCurrent draft:\n${p.body}` : ""}\n\nWrite the listing.`,
    });
    const title = out.title.trim().slice(0, 70) || template.title;
    let body = out.body.trim();
    if (!body.includes(contactLine)) body = `${body}\n\n${contactLine}`;
    return { title, body };
  } catch (err) {
    ctx.log.warn("sublet post draft failed; using template", { error: String(err) });
    return template;
  }
}

const EDIT =
  /\b(change|make it|shorter|longer|mention|add|remove|drop|instead|rewrite|redo|say|call it|don'?t say)\b/i;

/** "change the title", "mention the porch": an edit to the draft. */
export function wantsPostEdit(text: string): boolean {
  return EDIT.test(text);
}

function contactLineFor(ctx: ElfContext, code: string): string {
  const number = ctx.batch.messages[ctx.batch.messages.length - 1]?.agentHandle ?? "this number";
  return `Text ${number} and mention ref ${code} to set up a viewing.`;
}

function postText(p: Omit<SubletPost, "updatedAt">): string {
  return `${p.title}\n\n${p.body}`;
}

const PASTE_HINT =
  'Paste that on Craigslist (housing › sublets & temporary) or Facebook Marketplace. Send room photos and I\'ll work them in; say "change …" to edit, or "post it" when it\'s good.';

/**
 * The owner's side of subletting their own room. Returns null when the text is not about that, so the
 * hunt and the canned skills get their turn.
 */
export async function handleSubletOut(
  ctx: ElfContext,
  text: string,
  parent: string,
): Promise<ElfResult | null> {
  const saved = await ctx.store.getSubletPost(ctx.move.id);
  const active = saved && saved.status !== "approved";
  const intent = isSubletOutIntent(text);
  const photos = hasPhotos(ctx.batch);
  const now = ctx.now();
  const heuristic = extractSubletHeuristic(text, now);
  const givesFacts =
    heuristic.rentUsd != null ||
    heuristic.availableFrom != null ||
    heuristic.area != null ||
    heuristic.furnished != null ||
    heuristic.details.length > 0 ||
    heuristic.roomType != null;
  // A hunt ("looking for a room…") stays a hunt even while the owner's own post is half written.
  const hunting = !intent && !photos && extractHousingHeuristic(text, now).wantsSearchNow;
  if (hunting) return null;
  if (!intent && !(active && (photos || givesFacts || wantsPostEdit(text) || isApproval(text)))) return null;

  const events: NonNullable<ElfResult["events"]> = [];
  const reply = (lines: string[], extra: Partial<ElfResult> = {}): ElfResult => ({
    replies: [{ text: lines.filter(Boolean).join("\n"), parentMessageId: parent }],
    events,
    ...extra,
  });

  // Approval and edits on a finished draft.
  if (active && saved.status === "drafted" && !photos && !intent) {
    if (isApproval(text) && !wantsPostEdit(text) && !givesFacts) {
      const approved = await ctx.store.saveSubletPost({ ...saved, status: "approved" });
      events.push({ type: "sublet.post_approved", payload: { dealId: approved.dealId } });
      return reply(
        [
          "Great, that's the post. Once it's up, applicants text this number with the ref and I'll handle the back-and-forth; you only hear from me when someone's ready.",
        ],
        { boardPatch: { status: "waiting", lastUpdate: "Post approved; waiting for applicants" } },
      );
    }
    if (wantsPostEdit(text)) {
      // "mention the porch": the instruction goes to the writer and the fact into the post.
      const merged = mergePost(saved, heuristic, ctx.move);
      const code = saved.dealId ? (await ctx.store.getDeal(saved.dealId))?.code : null;
      const draft = await draftPost(ctx, merged, contactLineFor(ctx, code ?? "your ref"), text);
      const next = await ctx.store.saveSubletPost({ ...merged, ...draft, status: "drafted" });
      events.push({ type: "sublet.post_drafted", payload: { dealId: next.dealId, edit: text } });
      return reply([postText(next), "", 'Say "post it" when it\'s good, or keep editing.'], {
        boardPatch: { status: "working", lastUpdate: "Post redrafted" },
      });
    }
  }

  // Facts from this turn (the model refines the heuristic when there is one).
  let facts = heuristic;
  if (ctx.llm.name !== "fake" && (intent || givesFacts)) {
    try {
      const llm = await ctx.llm.extract(SubletFacts, {
        system:
          `Extract the facts about the room an owner wants to sublet out from their texts to a moving crew. Today is ${now.toISOString().slice(0, 10)}. ` +
          "Resolve relative dates to ISO dates. Only include what the owner actually said; null when unknown.",
        user: `${memoryPreamble(ctx.conversation)}\n\nOwner's latest message(s):\n"""${text}"""`,
      });
      facts = {
        ...llm,
        rentUsd: llm.rentUsd ?? heuristic.rentUsd,
        availableFrom: llm.availableFrom ?? heuristic.availableFrom,
        availableUntil: llm.availableUntil ?? heuristic.availableUntil,
        area: llm.area ?? heuristic.area,
        furnished: llm.furnished ?? heuristic.furnished,
        roomType: llm.roomType ?? heuristic.roomType,
        details: llm.details.length ? llm.details : heuristic.details,
      };
    } catch (err) {
      ctx.log.warn("sublet extraction failed; using heuristic", { error: String(err) });
    }
  }
  let post = mergePost(saved, facts, ctx.move);

  // Photos become the description.
  let photoLine = "";
  if (photos) {
    const seen = await describeRoomPhotos(ctx);
    if (seen.description) {
      const d = seen.description;
      post = {
        ...post,
        photoAttachmentIds: uniq([...post.photoAttachmentIds, ...seen.ids]),
        photoNotes: d.summary,
        roomType: post.roomType ?? d.roomType,
        furnished: post.furnished ?? d.furnished,
        details: uniq([...post.details, ...d.features]),
      };
      events.push({ type: "sublet.photos_read", payload: { photos: seen.ids.length, features: d.features } });
      photoLine = `Got the photo${seen.ids.length > 1 ? "s" : ""}: ${d.summary}`;
    } else if (seen.failed) {
      photoLine = "I couldn't read that photo; can you send it again?";
    }
  }

  // The deal opens the moment there is a rent: that is the owner's line, and the ref applicants quote.
  let deal = post.dealId ? await ctx.store.getDeal(post.dealId) : undefined;
  let justListed = false;
  if (post.rentCents != null) {
    if (!deal || deal.state === "dumped") {
      deal = await openDeal(ctx.store, {
        moveId: ctx.move.id,
        mode: "sublet_out",
        subjectId: null,
        title: post.roomType ?? "room",
        askCents: post.rentCents,
        limitCents: post.rentCents,
      });
      post = { ...post, dealId: deal.id };
      justListed = true;
      events.push({
        type: "deal.opened",
        payload: { dealId: deal.id, mode: "sublet_out", code: deal.code, cents: post.rentCents },
      });
    } else if (deal.askCents !== post.rentCents) {
      deal = await ctx.store.upsertDeal({ ...deal, askCents: post.rentCents, limitCents: post.rentCents });
      events.push({ type: "deal.repriced", payload: { dealId: deal.id, cents: post.rentCents } });
    }
  }
  events.push({
    type: "sublet.facts_updated",
    payload: {
      rentCents: post.rentCents,
      availableFrom: post.availableFrom,
      availableUntil: post.availableUntil,
      area: post.area,
    },
  });

  const listedLine =
    justListed && deal
      ? `Listed your room at ${fmtPrice(post.rentCents ?? 0, "month")} (ref ${deal.code}). Applicants text this number and I'll handle them; I won't go under that rent.`
      : "";
  const missing = missingForPost(post);
  if (missing) {
    await ctx.store.saveSubletPost({ ...post, status: "collecting" });
    const ask =
      missing === "rent"
        ? "What monthly rent should I list it at? I won't post anything until I have a number."
        : missing === "dates"
          ? "When is it free from, and until when?"
          : "Which neighborhood or street is it in?";
    return reply([listedLine, photoLine, ask], {
      boardPatch: {
        status: "waiting",
        currentTask: deal ? `Subletting your room (ref ${deal.code})` : "Subletting your room",
        lastUpdate: `Need ${missing} for the post`,
      },
    });
  }

  const draft = await draftPost(ctx, post, contactLineFor(ctx, deal?.code ?? "your ref"), null);
  const next = await ctx.store.saveSubletPost({ ...post, ...draft, status: "drafted" });
  events.push({ type: "sublet.post_drafted", payload: { dealId: next.dealId } });
  return reply(
    [
      listedLine,
      photoLine,
      listedLine || photoLine ? "" : "",
      "Here's the post:",
      "",
      postText(next),
      "",
      PASTE_HINT,
    ],
    {
      boardPatch: {
        status: "working",
        currentTask: `Subletting your room (ref ${deal?.code ?? "?"})`,
        lastUpdate: `Post drafted at ${fmtPrice(next.rentCents ?? 0, "month")}`,
      },
    },
  );
}
