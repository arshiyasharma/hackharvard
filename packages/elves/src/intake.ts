import { openDeal } from "@elves/engine";
import { prepareImage } from "@elves/llm";
import type { Item } from "@elves/shared";
import { z } from "zod";
import { type ElfContext, isImageAttachment } from "./contract.ts";
import { CATEGORIES, CATEGORY_WORDS, type Category, DEFAULT_WEIGHT_LB } from "./facts.ts";

export const ItemIdentification = z.object({
  items: z.array(
    z.object({
      name: z.string().describe("short item name, e.g. 'white plastic armchair'"),
      category: z.enum(CATEGORIES),
      condition: z.enum(["like_new", "good", "fair", "worn"]),
      weightLb: z.number().describe("estimated weight in pounds"),
      priceLowUsd: z
        .number()
        .describe("low end of a fair used resale price in a US college town, whole dollars"),
      priceHighUsd: z.number().describe("high end of that range, whole dollars"),
      title: z.string().describe("marketplace listing title, under 60 characters"),
      description: z.string().describe("one or two sentence listing description in a friendly, honest voice"),
    }),
  ),
  notes: z.string().nullable().describe("anything the owner should know, or null"),
});
export type ItemIdentification = z.infer<typeof ItemIdentification>;

export interface IntakeResult {
  items: Item[];
  failed: number;
  notes: string | null;
}

export interface BatchImage {
  id: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  base64: string;
}

/** Download and decode the batch's photos (HEIC included), at most `max`; unreadable ones are counted. */
export async function loadBatchImages(
  ctx: ElfContext,
  max = 4,
): Promise<{ images: BatchImage[]; failed: number }> {
  const photoIds = ctx.batch.messages.flatMap((m) =>
    m.attachments.filter(isImageAttachment).map((a) => a.id),
  );
  const images: BatchImage[] = [];
  let failed = 0;
  for (const id of photoIds.slice(0, max)) {
    try {
      const file = await ctx.fetchAttachment(id);
      if (!file) {
        failed++;
        continue;
      }
      const img = await prepareImage(file.bytes, file.contentType);
      if (!img) {
        failed++;
        continue;
      }
      images.push({ id, ...img });
    } catch (err) {
      failed++;
      ctx.log.warn("photo intake: could not prepare image", { id, error: String(err) });
    }
  }
  return { images, failed };
}

/** Download the batch's photos, identify the items with vision, and create or enrich `items` rows. */
export async function identifyFromPhotos(ctx: ElfContext): Promise<IntakeResult> {
  const photoIds = ctx.batch.messages.flatMap((m) => m.attachments.map((a) => a.id));
  if (photoIds.length === 0) return { items: [], failed: 0, notes: null };
  const { images, failed } = await loadBatchImages(ctx);
  if (images.length === 0 || ctx.signal.aborted) return { items: [], failed, notes: null };

  let ident: ItemIdentification;
  try {
    ident = await ctx.llm.extractFromImages(ItemIdentification, {
      system:
        "You identify furniture and household items in photos for a moving sale. One entry per distinct sellable item; " +
        "ignore people, pets and the room. Prices are fair used-resale ranges in a US college town (think Facebook Marketplace in Boston). " +
        "Be concrete about material, color and condition. If nothing sellable is visible, return an empty items list.",
      user: `The owner sent ${images.length} photo(s)${
        ctx.batch.messages.some((m) => m.text)
          ? ` with the text: "${ctx.batch.messages
              .map((m) => m.text)
              .filter(Boolean)
              .join(" / ")}"`
          : ""
      }. Identify the items.`,
      images: images.map(({ mediaType, base64 }) => ({ mediaType, base64 })),
    });
  } catch (err) {
    ctx.log.warn("photo intake: vision failed", { error: String(err) });
    return { items: [], failed: failed + images.length, notes: null };
  }

  const existing = await ctx.store.listItems(ctx.move.id);
  const out: Item[] = [];
  for (const it of ident.items) {
    const match = existing.find((e) => !e.title && sameItem(e.name, it.name, it.category as Category));
    const row = await ctx.store.upsertItem({
      ...(match ? { id: match.id } : {}),
      moveId: ctx.move.id,
      name: it.name,
      category: it.category,
      weightLb: Math.round(it.weightLb) || DEFAULT_WEIGHT_LB[it.category as Category],
      title: clean(it.title),
      description: clean(it.description),
      condition: it.condition,
      priceLowCents: Math.round(it.priceLowUsd * 100),
      priceHighCents: Math.round(it.priceHighUsd * 100),
      listPriceCents: match?.listPriceCents ?? suggestListCents(it.priceLowUsd * 100, it.priceHighUsd * 100),
      photoAttachmentIds: [...(match?.photoAttachmentIds ?? []), ...images.map((i) => i.id)],
    });
    out.push(row);
  }
  return { items: out, failed, notes: ident.notes };
}

/** Structured outputs occasionally trail a stray brace or quote; strip them. */
function clean(text: string): string {
  return text
    .replace(/[}\]"'\s]+$/g, "")
    .replace(/^[{["'\s]+/g, "")
    .trim();
}

const APPROVAL =
  /\b(yes|yep|yeah|yup|sure|ok|okay|go ahead|list it|post it|do it|sounds good|go for it|approved)\b/i;
const DECLINE = /\b(no|nope|don't|dont|hold|wait|not yet|pull it)\b/i;

/** Did the owner approve listing? Only meaningful when an item is awaiting approval. */
export function isApproval(text: string): boolean {
  return APPROVAL.test(text) && !DECLINE.test(text);
}

/** An approved item and the sell deal it opened: buyers quote `dealCode` in their first text. */
export type ApprovedItem = Item & { dealId: string; dealCode: string };

/** Mark every priced, unapproved item as approved and open its sell deal; returns the items that flipped. */
export async function approvePendingListings(ctx: ElfContext, text = ""): Promise<ApprovedItem[]> {
  const items = await ctx.store.listItems(ctx.move.id);
  const pending = items.filter((i) => i.floorPriceCents != null && !i.listingApproved);
  const out: ApprovedItem[] = [];
  for (const it of chooseToApprove(text, pending, await ctx.store.listEvents(ctx.move.id))) {
    const item = await ctx.store.upsertItem({
      id: it.id,
      moveId: it.moveId,
      name: it.name,
      category: it.category,
      listingApproved: true,
    });
    const deal = await openDeal(ctx.store, {
      moveId: item.moveId,
      mode: "sell_item",
      subjectId: item.id,
      title: item.name,
      askCents: item.listPriceCents ?? item.floorPriceCents,
      limitCents: item.floorPriceCents,
    });
    out.push({ ...item, dealId: deal.id, dealCode: deal.code });
  }
  return out;
}

const ALL_OF_THEM = /\b(all of them|them all|both|everything|(?:list|post) (?:them )?all)\b/i;

/**
 * Which pending items a yes covers: the item the text names; every pending item for "both" / "all of them";
 * the only one when just one is waiting; else the one whose floor was set most recently, which is the item the
 * last "want me to list it?" was about.
 */
export function chooseToApprove(
  text: string,
  pending: Item[],
  events: { type: string; payload: Record<string, unknown> }[],
): Item[] {
  if (pending.length <= 1) return pending;
  const t = text.toLowerCase();
  const named = pending.find((i) => t.includes(i.name.toLowerCase()));
  if (named) return [named];
  for (const [cat, words] of Object.entries(CATEGORY_WORDS) as [Category, string[]][]) {
    if (words.some((w) => new RegExp(`(^|[^a-z])${w}(es|s)?([^a-z]|$)`).test(t))) {
      const m = pending.find((i) => i.category === cat);
      if (m) return [m];
    }
  }
  if (ALL_OF_THEM.test(t)) return pending;
  const last = [...events]
    .reverse()
    .find((e) => e.type === "item.floor_set" && pending.some((p) => p.id === e.payload.itemId));
  return [pending.find((p) => p.id === last?.payload.itemId) ?? (pending[pending.length - 1] as Item)];
}

/** onSent for the owner-chat message that announced these listings: their deal summaries thread under it. */
export function anchorDeals(
  ctx: ElfContext,
  approved: ApprovedItem[],
): ((id: string) => Promise<void>) | undefined {
  if (!approved.length) return undefined;
  return async (messageId) => {
    for (const a of approved) {
      const deal = await ctx.store.getDeal(a.dealId);
      if (deal && !deal.ownerThreadId) await ctx.store.upsertDeal({ ...deal, ownerThreadId: messageId });
    }
  };
}

/** The line the owner pastes into a marketplace post, so buyers land in the right deal. */
export function postLine(a: ApprovedItem, number: string | null): string {
  const priceText = a.listPriceCents != null ? `, ${fmtUsd(a.listPriceCents)}` : "";
  return `"${a.title ?? a.name}${priceText}. Text ${number ?? "this number"} and mention ${a.dealCode}."`;
}

/** Compact per-item status for prompts, so an Elf never asks for what it already has. */
export function itemStatus(items: Item[]) {
  return items.map((i) => ({
    name: i.name,
    hasPhoto: i.photoAttachmentIds.length > 0,
    range:
      i.priceLowCents != null && i.priceHighCents != null
        ? `${fmtUsd(i.priceLowCents)}-${fmtUsd(i.priceHighCents)}`
        : null,
    floor: i.floorPriceCents != null ? fmtUsd(i.floorPriceCents) : null,
    listPrice: i.listPriceCents != null ? fmtUsd(i.listPriceCents) : null,
    listingApproved: i.listingApproved,
    outcome: i.outcome,
  }));
}

function sameItem(existingName: string, newName: string, category: Category): boolean {
  const a = existingName.toLowerCase();
  const b = newName.toLowerCase();
  if (a === b || b.includes(a) || a.includes(b)) return true;
  const words = CATEGORY_WORDS[category] ?? [];
  return words.some((w) => a.includes(w)) && words.some((w) => b.includes(w));
}

/** List at the upper-middle of the range, rounded to a friendly number. */
export function suggestListCents(lowCents: number, highCents: number): number {
  const mid = lowCents + (highCents - lowCents) * 0.6;
  const usd = mid / 100;
  const rounded =
    usd >= 100 ? Math.round(usd / 10) * 10 : usd >= 20 ? Math.round(usd / 5) * 5 : Math.round(usd);
  return Math.max(rounded, 1) * 100;
}

/**
 * A price the owner typed: "$4", "4 dollars", "4 bucks", "lowest 60", "I'd take 80", "floor is 50", or a bare number.
 * Returns cents, or null when the text isn't a price.
 */
export function parsePriceCents(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const money =
    t.match(/\$\s?(\d{1,5}(?:\.\d{1,2})?)/) ?? t.match(/\b(\d{1,5}(?:\.\d{1,2})?)\s?(?:dollars|bucks|usd)\b/);
  if (money?.[1]) return Math.round(Number(money[1]) * 100);
  const phrased = t.match(
    /\b(?:lowest|floor|minimum|min|at least|take|accept|go as low as|no lower than|bottom)\b[^0-9$]{0,20}(\d{1,5})\b/,
  );
  if (phrased?.[1]) return Math.round(Number(phrased[1]) * 100);
  const bare = t.match(/^(\d{1,5})\s*\??$/);
  if (bare?.[1]) return Number(bare[1]) * 100;
  return null;
}

export function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export function describeItem(it: Item): string {
  const cond = it.condition ? `, ${it.condition.replace("_", " ")} condition` : "";
  const range =
    it.priceLowCents != null && it.priceHighCents != null
      ? `, ${fmtUsd(it.priceLowCents)}–${fmtUsd(it.priceHighCents)}`
      : "";
  return `${it.name}${cond}${range}`;
}
