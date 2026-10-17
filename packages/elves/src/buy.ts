import { prepareImage } from "@elves/llm";
import type { Item } from "@elves/shared";
import { z } from "zod";
import {
  batchText,
  type ElfContext,
  type ElfResult,
  hasPhotos,
  lastMessageId,
  memoryPreamble,
} from "./contract.ts";
import { CATEGORIES, type Category, DEFAULT_WEIGHT_LB } from "./facts.ts";
import { fmtUsd } from "./intake.ts";

/**
 * Buy mode v1: the owner forwards a listing (link or screenshot) and a max price. The Elf reads it, checks the price
 * against a fair used range, flags scams, gives a verdict and drafts an offer. It never messages the seller; on a yes
 * it hands the owner the text to paste. (Seller negotiation is the Deal Engine's buy mode, after the merge.)
 *
 * A buy is stored as an item with intent "buy": `listPriceCents` is the seller's asking price, `floorPriceCents`
 * is the owner's MAX (the ceiling), `priceLow/HighCents` the fair range, `description` the link and summary, and
 * `listingApproved` means the owner approved the drafted offer.
 */

export const BUY_INTENT =
  /\b(should i (get|buy)|worth it|good deal|fair price|is this a scam|scam\?|buy (this|it|that)|thinking of buying|want to buy|looking to buy|offer for this|what should i offer)\b/i;
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i;

export function findUrl(text: string): string | null {
  return text.match(URL_RE)?.[0]?.replace(/[).,!?]+$/, "") ?? null;
}

/** "max 100", "up to $120", "budget 80", "no more than 90"; null when no ceiling is stated. */
export function parseMaxCents(text: string): number | null {
  const t = text.toLowerCase();
  const m =
    t.match(
      /\b(?:max(?:imum)?|up to|budget(?: is)?|no more than|at most|willing to (?:pay|spend)|spend)\b[^0-9$]{0,12}\$?\s?(\d{1,5})\b/,
    ) ?? t.match(/\$\s?(\d{1,5})\s*(?:max|tops|at most)\b/);
  return m?.[1] ? Number(m[1]) * 100 : null;
}

export const BuyListing = z.object({
  title: z.string().describe("what is for sale, short"),
  askingUsd: z.number().nullable().describe("the seller's asking price in whole dollars, null if not shown"),
  category: z.enum(CATEGORIES),
  condition: z.enum(["like_new", "good", "fair", "worn"]).nullable(),
  location: z.string().nullable(),
  fairLowUsd: z
    .number()
    .describe("low end of a fair used price for this item in a US college town, whole dollars"),
  fairHighUsd: z.number().describe("high end of that range"),
  sellerText: z
    .string()
    .nullable()
    .describe("the seller's own words from the listing, verbatim, up to 400 characters"),
});
export type BuyListing = z.infer<typeof BuyListing>;

export type BuyVerdict = "good_deal" | "fair" | "overpriced" | "likely_scam" | "unknown";

/** Scam Shield rules that apply to a listing the owner wants to buy; each flag names its rule. */
const SCAM_RULES: [string, RegExp][] = [
  [
    "pay outside escrow (Zelle, Venmo, Cash App, gift cards, wire)",
    /\b(zelle|venmo|cash ?app|gift cards?|wire transfer|western union|moneygram|bitcoin|crypto)\b[^.!?\n]{0,60}\b(first|before|deposit|hold|reserve|up front|upfront)\b|\b(gift cards?|wire transfer|western union|moneygram)\b/i,
  ],
  [
    "deposit before seeing it",
    /\b(deposit|pay(?:ment)?)\b[^.!?\n]{0,40}\b(before|prior to)\b[^.!?\n]{0,30}\b(pick ?up|viewing|seeing|meet)/i,
  ],
  [
    "asks for ID, SSN or a paid check",
    /\b(ssn|social security|id photo|photo of (?:your )?id|credit check|verification code)\b/i,
  ],
  [
    "seller can't meet (away, shipping only)",
    /\b(out of (the )?country|overseas|abroad|deployed|shipping only|will ship|courier|send a mover)\b/i,
  ],
];

export function buyScamFlags(
  listing: Pick<BuyListing, "askingUsd" | "fairLowUsd" | "sellerText" | "title">,
): string[] {
  const text = `${listing.title}\n${listing.sellerText ?? ""}`;
  const flags = SCAM_RULES.filter(([, re]) => re.test(text)).map(([name]) => name);
  if (listing.askingUsd != null && listing.fairLowUsd > 0 && listing.askingUsd < listing.fairLowUsd * 0.65)
    flags.push("priced more than 35% below similar items");
  return flags;
}

/** Pure: verdict and the offer to draft. The offer never exceeds the owner's max or the asking price. */
export function buyDecision(input: {
  askingCents: number | null;
  fairLowCents: number;
  fairHighCents: number;
  maxCents: number | null;
  flags: string[];
}): { verdict: BuyVerdict; offerCents: number | null; overMax: boolean } {
  const { askingCents: ask, fairLowCents: lo, fairHighCents: hi, maxCents: max, flags } = input;
  const hard = flags.some((f) => !f.startsWith("priced"));
  if (hard || (flags.length && ask != null && ask < lo * 0.5))
    return { verdict: "likely_scam", offerCents: null, overMax: false };
  if (ask == null) return { verdict: "unknown", offerCents: null, overMax: false };
  const verdict: BuyVerdict = ask <= lo ? "good_deal" : ask <= hi ? "fair" : "overpriced";
  const round5 = (c: number) => Math.round(c / 500) * 500;
  const mid = (lo + hi) / 2;
  let offer = verdict === "good_deal" ? ask : round5(Math.max(lo, Math.min(ask * 0.85, mid)));
  offer = Math.min(offer, ask);
  const overMax = max != null && offer > max;
  if (max != null) offer = Math.min(offer, max);
  return { verdict, offerCents: Math.max(offer, 100), overMax };
}

const VERDICT_WORDS: Record<BuyVerdict, string> = {
  good_deal: "a good deal",
  fair: "a fair price",
  overpriced: "overpriced",
  likely_scam: "a likely scam",
  unknown: "hard to judge without a price",
};

/** Read a listing page without a browser: title, description and price from the HTML; null if blocked. */
export async function fetchListingText(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 400_000);
    const meta = (p: string) =>
      html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)`, "i"))?.[1] ??
      "";
    const title = meta("og:title") || html.match(/<title[^>]*>([^<]+)/i)?.[1] || "";
    const body = html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    const text = [
      title,
      meta("og:description"),
      meta("product:price:amount") && `Price: $${meta("product:price:amount")}`,
      body.slice(0, 5000),
    ]
      .filter(Boolean)
      .join("\n");
    return text.length > 40 ? text : null;
  } catch {
    return null;
  }
}

const READ_SYSTEM =
  "You read a used-item listing that someone wants to buy. Extract what is for sale and the asking price exactly as listed. " +
  "Estimate a fair used price range for it in a US college town (think Facebook Marketplace in Boston). Quote the seller's own words verbatim. " +
  "Only describe what is in the listing; never invent a price.";

/** Read the listing from a screenshot or a link; null with a reason when neither works. */
async function readListing(
  ctx: ElfContext,
  text: string,
): Promise<{ listing: BuyListing; url: string | null } | { error: string }> {
  const url = findUrl(text);
  if (hasPhotos(ctx.batch)) {
    const id = ctx.batch.messages.flatMap((m) => m.attachments.map((a) => a.id))[0];
    const file = id ? await ctx.fetchAttachment(id) : null;
    const img = file ? await prepareImage(file.bytes, file.contentType) : null;
    if (!img) return { error: "photo" };
    try {
      const listing = await ctx.llm.extractFromImages(BuyListing, {
        system: READ_SYSTEM,
        user: `A screenshot of the listing. The owner said: "${text}". Read it.`,
        images: [img],
      });
      return { listing, url };
    } catch (err) {
      ctx.log.warn("buy: screenshot read failed", { error: String(err) });
      return { error: "photo" };
    }
  }
  if (!url) return { error: "nothing" };
  const page = await fetchListingText(url, ctx.signal);
  if (!page) return { error: "blocked" };
  try {
    const listing = await ctx.llm.extract(BuyListing, {
      system: READ_SYSTEM,
      user: `Listing page at ${url}:\n"""${page}"""`,
    });
    return { listing, url };
  } catch (err) {
    ctx.log.warn("buy: page read failed", { url, error: String(err) });
    return { error: "blocked" };
  }
}

const SYSTEM = `You are the Stuff Elf of Elves, a moving crew the owner texts. The owner forwarded a listing they're thinking of buying. You give a straight verdict and draft an offer; you never contact the seller.

Write the reply as a text message:
- Plain text only, 2 to 4 short lines, no markdown, at most one emoji (usually none).
- Line 1: what it is, the asking price and your verdict (exactly the verdict in the facts) with the fair range.
- If scamFlags is non-empty: say plainly why it looks like a scam (name each flag) and tell them not to pay anything up front. Draft no offer.
- If needMax is true: ask for the most they'd pay, and nothing else.
- Otherwise: give the drafted offer in quotes, exactly as in offerText, then ask whether they want to send it.
- If overMax is true, say the fair offer is above their max so the draft is at their max.
- Never change any number in the facts.`;

/** Handle a forwarded listing (new) or the owner's max for the last one (follow-up). */
export async function handleBuy(ctx: ElfContext, pending: Item | null): Promise<ElfResult> {
  const text = batchText(ctx.batch);
  const events: NonNullable<ElfResult["events"]> = [];
  let item = pending;
  const maxSaid = parseMaxCents(text) ?? (pending ? bareDollars(text) : null);

  if (!pending || findUrl(text) || hasPhotos(ctx.batch)) {
    const read = await readListing(ctx, text);
    if (ctx.signal.aborted) return { replies: [] };
    if ("error" in read) {
      const reply =
        read.error === "blocked"
          ? "That site won't let me read the listing. Can you send a screenshot of it instead?"
          : read.error === "photo"
            ? "I couldn't read that screenshot. Can you send a clearer one?"
            : "Send me the listing link or a screenshot, plus the most you'd pay, and I'll tell you if it's a good deal.";
      return {
        replies: [{ text: reply, parentMessageId: lastMessageId(ctx.batch) }],
        boardPatch: {
          status: "waiting",
          currentTask: "Evaluating a listing",
          lastUpdate: "Waiting on a readable listing",
        },
      };
    }
    const l = read.listing;
    item = await ctx.store.upsertItem({
      moveId: ctx.move.id,
      name: l.title.slice(0, 60),
      category: l.category,
      weightLb: DEFAULT_WEIGHT_LB[l.category as Category],
      intent: "buy",
      title: l.title.slice(0, 60),
      description: [read.url, l.location, l.sellerText].filter(Boolean).join(" · ").slice(0, 600),
      condition: l.condition,
      listPriceCents: l.askingUsd != null ? Math.round(l.askingUsd * 100) : null,
      priceLowCents: Math.round(l.fairLowUsd * 100),
      priceHighCents: Math.round(l.fairHighUsd * 100),
      floorPriceCents: maxSaid,
      listingApproved: false,
    });
    events.push({
      type: "buy.evaluated",
      payload: {
        itemId: item.id,
        title: l.title,
        askingCents: item.listPriceCents,
        url: read.url,
        flags: buyScamFlags(l),
      },
    });
  } else if (maxSaid != null) {
    item = await ctx.store.upsertItem({
      id: pending.id,
      moveId: pending.moveId,
      name: pending.name,
      category: pending.category,
      floorPriceCents: maxSaid,
    });
  }
  if (!item) return { replies: [] };

  const flags = buyScamFlags({
    title: item.title ?? item.name,
    askingUsd: item.listPriceCents != null ? item.listPriceCents / 100 : null,
    fairLowUsd: (item.priceLowCents ?? 0) / 100,
    sellerText: item.description,
  });
  const d = buyDecision({
    askingCents: item.listPriceCents,
    fairLowCents: item.priceLowCents ?? 0,
    fairHighCents: item.priceHighCents ?? 0,
    maxCents: item.floorPriceCents,
    flags,
  });
  const needMax = !flags.length && d.verdict !== "unknown" && item.floorPriceCents == null;
  const offerText =
    d.offerCents != null && !needMax
      ? `Hi! Is the ${item.title ?? item.name} still available? I could do ${fmtUsd(d.offerCents)} and pick it up this week.`
      : null;
  events.push({
    type: offerText ? "buy.offer_drafted" : needMax ? "buy.needs_max" : "buy.verdict",
    payload: {
      itemId: item.id,
      verdict: d.verdict,
      offerCents: offerText ? d.offerCents : null,
      maxCents: item.floorPriceCents,
      flags,
    },
  });

  const facts = {
    item: item.title ?? item.name,
    asking: item.listPriceCents != null ? fmtUsd(item.listPriceCents) : null,
    verdict: VERDICT_WORDS[d.verdict],
    fairRange:
      item.priceLowCents != null && item.priceHighCents != null
        ? `${fmtUsd(item.priceLowCents)}-${fmtUsd(item.priceHighCents)}`
        : null,
    scamFlags: flags,
    needMax,
    overMax: d.overMax,
    offerText,
  };
  let reply = buyTemplate(facts);
  if (ctx.llm.name !== "fake") {
    try {
      const drafted = await ctx.llm.draft({
        system: SYSTEM,
        user: `${memoryPreamble(ctx.conversation)}\n\nFacts (JSON):\n${JSON.stringify(facts)}\n\nOwner's message:\n"""${text}"""\n\nWrite the reply.`,
        maxTokens: 300,
      });
      // The draft must carry the exact offer; otherwise the template's numbers win.
      if (!offerText || drafted.includes(fmtUsd(d.offerCents ?? 0))) reply = drafted;
    } catch (err) {
      ctx.log.warn("buy draft failed; using template", { error: String(err) });
    }
  }
  if (ctx.signal.aborted) return { replies: [] };
  return {
    replies: [{ text: reply, parentMessageId: lastMessageId(ctx.batch) }],
    events,
    boardPatch: {
      status: offerText || needMax ? "waiting" : "working",
      currentTask: `Evaluating ${item.title ?? item.name}`,
      lastUpdate: `${VERDICT_WORDS[d.verdict]}${offerText ? `; drafted an offer at ${fmtUsd(d.offerCents ?? 0)}` : ""}`,
    },
  };
}

/** The owner said yes to a drafted offer: hand them the text to paste (we never message the seller). */
export async function approveBuyOffer(ctx: ElfContext, item: Item, offerCents: number): Promise<ElfResult> {
  await ctx.store.upsertItem({
    id: item.id,
    moveId: item.moveId,
    name: item.name,
    category: item.category,
    listingApproved: true,
  });
  const offer = `Hi! Is the ${item.title ?? item.name} still available? I could do ${fmtUsd(offerCents)} and pick it up this week.`;
  return {
    replies: [
      {
        text: "Here's the offer to paste to the seller. Pay only when you see it in person, never by Zelle or gift card up front.",
        parentMessageId: lastMessageId(ctx.batch),
      },
      { text: offer, parentMessageId: null },
    ],
    events: [{ type: "buy.offer_approved", payload: { itemId: item.id, offerCents } }],
    boardPatch: {
      status: "waiting",
      currentTask: `Offer out on ${item.title ?? item.name}`,
      lastUpdate: `Owner sending ${fmtUsd(offerCents)}`,
    },
  };
}

function bareDollars(text: string): number | null {
  const m = text.trim().match(/^\$?\s?(\d{1,5})(?:\s*(?:dollars|bucks))?\s*$/i);
  return m?.[1] ? Number(m[1]) * 100 : null;
}

function buyTemplate(f: {
  item: string;
  asking: string | null;
  verdict: string;
  fairRange: string | null;
  scamFlags: string[];
  needMax: boolean;
  overMax: boolean;
  offerText: string | null;
}): string {
  const lines = [
    `${f.item}${f.asking ? ` at ${f.asking}` : ""} looks like ${f.verdict}${f.fairRange ? ` (similar ones go for ${f.fairRange})` : ""}.`,
  ];
  if (f.scamFlags.length) {
    lines.push(`Red flags: ${f.scamFlags.join("; ")}. Don't pay anything up front.`);
    return lines.join("\n");
  }
  if (f.needMax) lines.push("What's the most you'd pay for it?");
  else if (f.offerText) {
    if (f.overMax) lines.push("A fair offer is above your max, so I drafted it at your max.");
    lines.push(`Draft: "${f.offerText}"`);
    lines.push("Want to send it?");
  }
  return lines.join("\n");
}
