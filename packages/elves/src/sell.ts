import type { Item } from "@elves/shared";
import {
  batchText,
  type Elf,
  type ElfContext,
  type ElfResult,
  hasPhotos,
  lastMessageId,
  memoryPreamble,
} from "./contract.ts";
import { CATEGORY_WORDS, type Category } from "./facts.ts";
import {
  approvePendingListings,
  describeItem,
  fmtUsd,
  identifyFromPhotos,
  isApproval,
  itemStatus,
  parsePriceCents,
  suggestListCents,
} from "./intake.ts";
import { BUY_SKILL, GREEN_SKILL, pickSkill, type Skill, skillReply } from "./stubs.ts";

const SYSTEM = `You are the Stuff Elf of Elves, a moving crew the owner texts. You handle everything the owner owns or wants: right now you turn photos into listings, hold a floor price, and handle buyers who text this number so the owner never has to.

Write the reply as a text message:
- Plain text only, 2 to 3 short lines, no markdown, no bullet symbols, at most one emoji (usually none).
- If items were just identified from a photo, say what you see (material, color, condition) and the fair range in one line.
- If the owner gave a floor price, confirm it and the list price you'll use. If their floor is far below the range, say you'll list higher and never go under their floor unless they say so.
- If the owner just approved (justApproved non-empty), confirm it is listed at the list price and that buyers will text this number; then ask nothing.
- Otherwise ask for exactly ONE thing: the lowest price they'd take (if no floor yet), otherwise whether to go ahead and list it. If a photo could not be read, ask for a clearer photo.
- Never ask for a photo or a floor price for an item that already has one (see items).
- Buyers reach you by texting this same number; never claim you posted anywhere.
- Do not repeat details already confirmed earlier (see the conversation and working memory).`;

const SELL_SKILL: Skill = {
  id: "sell",
  keywords: [
    "sell",
    "selling",
    "list",
    "listing",
    "price",
    "dollar",
    "dollars",
    "bucks",
    "couch",
    "sofa",
    "mattress",
    "desk",
    "lamp",
    "dresser",
    "buyer",
    "offer",
    "lowest",
    "floor",
    "photo",
    "pickup",
  ],
  task: "Waiting on a photo",
  reply: "",
};

export const stuffElf: Elf = {
  name: "stuff",
  description:
    "The owner's stuff: selling furniture and items (photos, listings, prices and floor prices, dollar amounts, buyers, pickups), buying things (a forwarded listing link or screenshot, offers), and getting rid of the rest (donations, giving away free, 311 or bulk pickup, trash, recycling, Last Call, the Move Report)",
  keywords: [...SELL_SKILL.keywords, ...BUY_SKILL.keywords, ...GREEN_SKILL.keywords],

  async handle(ctx: ElfContext): Promise<ElfResult> {
    const text = batchText(ctx.batch);
    // Buying and giving away are still canned; selling (and any photo) runs the real flow below.
    if (!hasPhotos(ctx.batch)) {
      const { skill } = pickSkill(text, [SELL_SKILL, BUY_SKILL, GREEN_SKILL]);
      if (skill !== SELL_SKILL) return skillReply(ctx, "stuff", skill);
    }
    const events: ElfResult["events"] = [];
    const intake = await identifyFromPhotos(ctx);
    for (const it of intake.items) {
      events.push({
        type: "item.identified",
        payload: {
          itemId: it.id,
          name: it.name,
          category: it.category,
          condition: it.condition,
          priceLowCents: it.priceLowCents,
          priceHighCents: it.priceHighCents,
        },
      });
    }
    if (ctx.signal.aborted) return { replies: [] };

    const items = await ctx.store.listItems(ctx.move.id);
    const price = parsePriceCents(text);
    let priced: Item | null = null;
    if (price != null && items.length) {
      const target = pickTarget(text, items, intake.items);
      if (target) {
        const list =
          target.priceLowCents != null && target.priceHighCents != null
            ? Math.max(price, suggestListCents(target.priceLowCents, target.priceHighCents))
            : price;
        priced = await ctx.store.upsertItem({
          id: target.id,
          moveId: target.moveId,
          name: target.name,
          category: target.category,
          floorPriceCents: price,
          listPriceCents: list,
        });
        events.push({
          type: "item.floor_set",
          payload: { itemId: target.id, name: target.name, floorPriceCents: price, listPriceCents: list },
        });
      }
    }

    let justApproved: Item[] = [];
    if (price == null && intake.items.length === 0 && isApproval(text)) {
      justApproved = await approvePendingListings(ctx);
      for (const it of justApproved)
        events.push({
          type: "listing.approved",
          payload: { itemId: it.id, name: it.name, listPriceCents: it.listPriceCents },
        });
    }
    const current = await ctx.store.listItems(ctx.move.id);
    const needsFloor = current.filter((i) => i.floorPriceCents == null && i.id !== priced?.id);
    const facts = {
      justApproved: justApproved.map((i) => ({
        name: i.name,
        listPrice: i.listPriceCents != null ? fmtUsd(i.listPriceCents) : null,
      })),
      items: itemStatus(current),
      identifiedNow: intake.items.map((i) => ({
        name: i.name,
        condition: i.condition,
        range:
          i.priceLowCents != null && i.priceHighCents != null
            ? `${fmtUsd(i.priceLowCents)}-${fmtUsd(i.priceHighCents)}`
            : null,
      })),
      photosUnreadable: intake.failed,
      floorJustSet: priced
        ? {
            name: priced.name,
            floor: fmtUsd(priced.floorPriceCents ?? 0),
            listPrice: fmtUsd(priced.listPriceCents ?? 0),
            belowRange: priced.priceLowCents != null && (priced.floorPriceCents ?? 0) < priced.priceLowCents,
          }
        : null,
      itemsStillNeedingAFloor: needsFloor.map((i) => i.name),
      ownerSaid: text,
    };

    let reply: string;
    if (ctx.llm.name !== "fake") {
      try {
        reply = await ctx.llm.draft({
          system: SYSTEM,
          user: `${memoryPreamble(ctx.conversation)}\n\nFacts captured this turn (JSON):\n${JSON.stringify(facts)}\n\nOwner's latest message(s):\n"""${text}"""\n\nWrite the reply.`,
          maxTokens: 400,
        });
      } catch (err) {
        ctx.log.warn("sell draft failed; using template", { error: String(err) });
        reply = template(facts, intake.items, priced, justApproved);
      }
    } else {
      reply = template(facts, intake.items, priced, justApproved);
    }
    if (ctx.signal.aborted) return { replies: [] };

    const working = current.filter((i) => i.outcome === "listed").map((i) => i.name);
    return {
      replies: [{ text: reply, parentMessageId: lastMessageId(ctx.batch) }],
      events,
      boardPatch: {
        status: "working",
        currentTask: working.length ? `Listing ${working.join(", ")}` : "Waiting on a photo",
        lastUpdate: justApproved.length
          ? `Listed ${justApproved.map((i) => i.name).join(", ")}; buyers text this number`
          : priced
            ? `Floor ${fmtUsd(priced.floorPriceCents ?? 0)} on the ${priced.name}`
            : intake.items.length
              ? `Identified ${intake.items.map((i) => i.name).join(", ")}`
              : "Replied to the owner",
      },
    };
  },
};

function pickTarget(text: string, items: Item[], justIdentified: Item[]): Item | null {
  const t = text.toLowerCase();
  const byName = items.find((i) => t.includes(i.name.toLowerCase()));
  if (byName) return byName;
  for (const [cat, words] of Object.entries(CATEGORY_WORDS) as [Category, string[]][]) {
    if (words.some((w) => new RegExp(`(^|[^a-z])${w}(es|s)?([^a-z]|$)`).test(t))) {
      const m = items.find((i) => i.category === cat);
      if (m) return m;
    }
  }
  if (justIdentified.length) return justIdentified[0] ?? null;
  const noFloor = [...items].reverse().find((i) => i.floorPriceCents == null);
  return noFloor ?? items[items.length - 1] ?? null;
}

function template(
  facts: { photosUnreadable: number; itemsStillNeedingAFloor: string[] },
  identified: Item[],
  priced: Item | null,
  approved: Item[],
): string {
  const lines: string[] = [];
  if (approved.length) {
    lines.push(
      `Listed: ${approved.map((i) => `${i.name} at ${fmtUsd(i.listPriceCents ?? 0)}`).join(", ")}. Buyers text this number and I'll keep you posted.`,
    );
    return lines.join("\n");
  }
  if (identified.length) lines.push(`I see ${identified.map(describeItem).join("; ")}.`);
  if (facts.photosUnreadable && !identified.length)
    lines.push("I couldn't read that photo. Can you send a clearer one?");
  if (priced) {
    const below = priced.priceLowCents != null && (priced.floorPriceCents ?? 0) < priced.priceLowCents;
    lines.push(
      `Floor ${fmtUsd(priced.floorPriceCents ?? 0)} on the ${priced.name}; I'll list it at ${fmtUsd(priced.listPriceCents ?? 0)}${below ? " and never go under your floor unless you say so" : ""}.`,
    );
  }
  if (!priced && facts.itemsStillNeedingAFloor.length) {
    lines.push(`What's the lowest you'd take for the ${facts.itemsStillNeedingAFloor[0]}?`);
  } else if (priced) {
    lines.push("Want me to go ahead and list it? Buyers will text this number.");
  } else if (!lines.length) {
    lines.push("Send me a photo of what you're selling and I'll price it.");
  }
  return lines.join("\n");
}
