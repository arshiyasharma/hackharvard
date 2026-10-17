import type { Item } from "@elves/shared";
import { approveBuyOffer, BUY_INTENT, findUrl, handleBuy, parseMaxCents } from "./buy.ts";
import {
  batchText,
  type Elf,
  type ElfContext,
  type ElfResult,
  hasPhotos,
  lastMessageId,
  memoryPreamble,
} from "./contract.ts";
import { noDealHooks } from "./deal-hooks.ts";
import { pickupFor } from "./donate.ts";
import { formatDate } from "./facts.ts";
import { moveReport, reportText } from "./impact.ts";
import {
  approvePendingListings,
  describeItem,
  findItemByText,
  fmtUsd,
  identifyFromPhotos,
  isApproval,
  itemStatus,
  openDeals,
  parsePriceCents,
  suggestListCents,
} from "./intake.ts";
import { bostonTime, LAST_CALL_HOUR_ET } from "./last-call.ts";
import { keywordScore } from "./router.ts";
import { BUY_SKILL, GREEN_SKILL, pickSkill, type Skill } from "./stubs.ts";
import {
  applyIntent,
  type Changed,
  fromModel,
  openItems,
  outcomeFor,
  parseStuffAction,
  recordOutcome,
  resolveTargets,
  type StuffAction,
  StuffActionSchema,
} from "./stuff-actions.ts";

const SYSTEM = `You are the Stuff Elf of Elves, a moving crew the owner texts. You handle everything the owner owns or wants: right now you turn photos into listings, hold a floor price, and handle buyers who text this number so the owner never has to.

Write the reply as a text message:
- Plain text only, 2 to 3 short lines, no markdown, no bullet symbols, at most one emoji (usually none).
- If items were just identified from a photo, say what you see (material, color, condition) and the fair range in one line.
- If the owner gave a floor price, confirm it and the list price you'll use. If their floor is far below the range, say you'll list higher and never go under their floor unless they say so.
- If the owner just approved (justApproved non-empty), confirm each item is listed at its list price. If an item has a code, tell them buyers text that code to reach you; otherwise say buyers text this number. Then ask nothing.
- If stillAwaitingApproval is non-empty after an approval, ask about the first one only.
- Otherwise ask for exactly ONE thing: the lowest price they'd take (if no floor yet), otherwise whether to go ahead and list it. If a photo could not be read, ask for a clearer photo.
- Never ask for a photo or a floor price for an item that already has one (see items).
- Never claim you posted anywhere.
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

/** What the Stuff Elf asked last, so a bare "yes" or "100" answers the right question. */
type PendingAsk =
  | { kind: "list"; item: Item }
  | { kind: "buy_max"; item: Item }
  | { kind: "buy_send"; item: Item; offerCents: number };

async function lastStuffAsk(ctx: ElfContext): Promise<PendingAsk | null> {
  const [events, items] = await Promise.all([
    ctx.store.listEvents(ctx.move.id),
    ctx.store.listItems(ctx.move.id),
  ]);
  for (const e of [...events].reverse()) {
    const item = items.find((i) => i.id === e.payload.itemId);
    if (!item) continue;
    if (e.type === "item.floor_set") {
      if (!item.listingApproved && item.outcome === "listed" && item.intent === "sell")
        return { kind: "list", item };
      return null;
    }
    if (e.type === "buy.needs_max") return item.floorPriceCents == null ? { kind: "buy_max", item } : null;
    if (e.type === "buy.offer_drafted") {
      const cents = e.payload.offerCents;
      return !item.listingApproved && typeof cents === "number"
        ? { kind: "buy_send", item, offerCents: cents }
        : null;
    }
    if (e.type === "listing.approved" || e.type === "buy.offer_approved") return null;
  }
  return null;
}

export const stuffElf: Elf = {
  name: "stuff",
  description:
    "The owner's stuff: selling furniture and items (photos, listings, prices and floor prices, dollar amounts, buyers, pickups), buying things (a forwarded listing link or screenshot, offers, is it a good deal), and what happens to everything else (donating, giving away free, keeping an item, the curb, 311 or bulk pickup, telling us something sold or got picked up, Last Call, the Move Report)",
  keywords: [
    ...SELL_SKILL.keywords,
    ...BUY_SKILL.keywords,
    ...GREEN_SKILL.keywords,
    "keep",
    "keeping",
    "picked up",
  ],

  async handle(ctx: ElfContext): Promise<ElfResult> {
    const text = batchText(ctx.batch);
    const photos = hasPhotos(ctx.batch);
    const pending = await lastStuffAsk(ctx);

    // Buying: a forwarded link, a screenshot with buy words, or an answer to the last buy question.
    if (findUrl(text) || BUY_INTENT.test(text)) return handleBuy(ctx, null);
    if (pending?.kind === "buy_max" && !photos && (parseMaxCents(text) ?? parsePriceCents(text)) != null)
      return handleBuy(ctx, pending.item);
    if (pending?.kind === "buy_send" && !photos && isApproval(text) && parsePriceCents(text) == null)
      return approveBuyOffer(ctx, pending.item, pending.offerCents);

    // Donate, give away, keep, "it sold / got picked up", the report, what's left.
    if (!photos) {
      const action = await parseAction(ctx, text);
      if (action) {
        const res = await handleAction(ctx, action, text);
        if (res) return res;
      }
      const { skill } = pickSkill(text, [SELL_SKILL, BUY_SKILL, GREEN_SKILL]);
      if (skill === BUY_SKILL) return handleBuy(ctx, null);
      if (skill === GREEN_SKILL) return lastCallExplainer(ctx);
    }
    return sell(ctx, text);
  },
};

/** Regex first; the fast model only when the text smells like an action the regex missed. */
async function parseAction(ctx: ElfContext, text: string): Promise<StuffAction | null> {
  const parsed = parseStuffAction(text);
  if (parsed) return parsed;
  if (ctx.llm.name === "fake" || keywordScore(text, GREEN_SKILL.keywords) === 0) return null;
  try {
    const r = await ctx.llm.extract(StuffActionSchema, {
      system:
        "An owner who is moving texted their moving crew about their stuff. Say what they want done: donate, give (away for free, or the curb), keep (taking it with them), " +
        "or report an outcome that already happened (sold, donated, given, dumped, picked_up), or ask for the report or status. Use none when it is none of these.",
      user: text,
    });
    return fromModel(r);
  } catch (err) {
    ctx.log.warn("stuff action extraction failed", { error: String(err) });
    return null;
  }
}

const listNames = (items: Item[]) => {
  const n = items.map((i) => i.name);
  return n.length <= 2 ? n.join(" and ") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
};

/** Apply an owner action; null when it names no item we have (so "keep me posted" falls through). */
async function handleAction(ctx: ElfContext, action: StuffAction, text: string): Promise<ElfResult | null> {
  const parent = lastMessageId(ctx.batch);
  const now = ctx.now();
  const deals = ctx.deals ?? noDealHooks;
  const items = await ctx.store.listItems(ctx.move.id);

  if (action.kind === "report") {
    const report = moveReport(items, await ctx.store.listEvents(ctx.move.id));
    return {
      replies: [{ text: reportText(report), parentMessageId: parent }],
      events: [
        {
          type: "report.sent",
          payload: { lbDiverted: report.lbDiverted, kgCo2eAvoided: report.kgCo2eAvoided },
        },
      ],
      boardPatch: { status: "working", lastUpdate: `Move Report: ${report.lbDiverted} lb diverted so far` },
    };
  }
  if (action.kind === "status") return statusReply(ctx, items);

  const events: Changed["events"] = [];
  const lines: string[] = [];

  if (action.kind === "gone") {
    const targets = resolveTargets(items, action.names, false);
    if (!targets.length) return null;
    const price = parsePriceCents(text);
    for (const it of targets) {
      const outcome = outcomeFor(it, action.outcome);
      const extra = outcome === "sold" && price != null && targets.length === 1 ? { agreedCents: price } : {};
      const res = await recordOutcome(ctx.store, it, outcome, now, extra);
      if (outcome === "sold" && "agreedCents" in extra)
        res.events.push({ type: "item.sold", payload: { itemId: it.id, cents: price, via: "owner" } });
      if (it.listingApproved)
        await deals.itemWithdrawn(res.item, outcome === "dumped" ? "dumped" : "sold_elsewhere");
      events.push(...res.events);
    }
    const report = moveReport(
      await ctx.store.listItems(ctx.move.id),
      await ctx.store.listEvents(ctx.move.id),
    );
    const what = targets.map((t) => `${t.name} ${outcomeFor(t, action.outcome)}`).join(", ");
    lines.push(`Logged: ${what}.`);
    if (targets.some((t) => outcomeFor(t, action.outcome) === "dumped"))
      lines.push("That one counts against the Move Report, but thanks for telling me.");
    else lines.push(`That's about ${report.lbDiverted} lb kept off the curb so far.`);
    return {
      replies: [{ text: lines.join("\n"), parentMessageId: parent }],
      events,
      boardPatch: { status: "working", lastUpdate: `Logged ${what}` },
    };
  }

  const targets = resolveTargets(items, action.names, action.targets === "rest");
  if (!targets.length) {
    if (action.kind === "keep") return null;
    const open = openItems(items);
    if (!open.length) return null;
    return {
      replies: [
        {
          text: `Which item should I ${action.kind === "donate" ? "donate" : "give away"}? I have ${listNames(open)}.`,
          parentMessageId: parent,
        },
      ],
    };
  }
  const wasListed = targets.filter((t) => t.listingApproved);
  for (const it of targets)
    events.push(...(await applyIntent(ctx.store, deals, it, action.kind, now)).events);

  if (action.kind === "keep") {
    lines.push(
      `Keeping the ${listNames(targets)}; ${targets.length === 1 ? "it goes" : "they go"} on the truck.`,
    );
    if (wasListed.length) lines.push(`I pulled the ${listNames(wasListed)} from sale.`);
  } else if (action.kind === "donate") {
    lines.push(
      `Got it, the ${listNames(targets)} ${targets.length === 1 ? "is" : "are"} for donation${wasListed.length ? " and off the sale list" : ""}.`,
    );
    const routes = [
      ...new Map(
        targets.map((t) => [pickupFor(t.category, t.condition).org, pickupFor(t.category, t.condition)]),
      ).values(),
    ];
    lines.push(
      `Best bet: ${routes.map((r) => `${r.org} (${r.how})`).join("; ")}. I haven't booked anything.`,
    );
    lines.push("Tell me once it's picked up and I'll log it.");
  } else {
    const curb = /\bcurb\b/i.test(text);
    lines.push(
      `${curb ? "Better than the curb: " : ""}the ${listNames(targets)} ${targets.length === 1 ? "is" : "are"} up for free now, first to pick up gets ${targets.length === 1 ? "it" : "them"}.`,
    );
    lines.push(
      "If nobody claims it before move-out, I'll line up a donation or 311 pickup so it doesn't end up on the sidewalk.",
    );
  }
  return {
    replies: [{ text: lines.join("\n"), parentMessageId: parent }],
    events,
    boardPatch: {
      status: "working",
      currentTask: action.kind === "keep" ? "Sorting what stays" : "Finding homes for the leftovers",
      lastUpdate: `${action.kind === "keep" ? "Keeping" : action.kind === "donate" ? "Donating" : "Giving away"} ${listNames(targets)}`,
    },
  };
}

function statusReply(ctx: ElfContext, items: Item[]): ElfResult {
  const open = openItems(items).filter((i) => i.intent !== "keep");
  const stage = (i: Item) =>
    i.intent === "donate"
      ? "for donation"
      : i.intent === "give" || i.listPriceCents === 0
        ? "free"
        : i.listingApproved
          ? `listed ${fmtUsd(i.listPriceCents ?? 0)}`
          : i.floorPriceCents != null
            ? "waiting on your OK to list"
            : "needs a lowest price";
  const lines = [
    open.length
      ? `Still open: ${open.map((i) => `${i.name} (${stage(i)})`).join(", ")}.`
      : "Nothing open right now; everything has a plan.",
  ];
  if (ctx.move.moveOutAt) {
    const t0 = bostonTime(ctx.move.moveOutAt, LAST_CALL_HOUR_ET);
    const start = new Date(t0.getTime() - 48 * 3600_000).toISOString().slice(0, 10);
    lines.push(
      `Last Call starts ${formatDate(start)}: prices drop, then whatever's left goes free so nothing hits the curb.`,
    );
  } else if (open.length)
    lines.push("Once I know your move-out date I'll schedule Last Call for anything unsold.");
  return { replies: [{ text: lines.join("\n"), parentMessageId: lastMessageId(ctx.batch) }] };
}

function lastCallExplainer(ctx: ElfContext): ElfResult {
  const res = statusReply(ctx, []);
  const when = ctx.move.moveOutAt ? res.replies[0]?.text.split("\n").pop() : null;
  const text = [
    "Anything unsold 2 days before move-out drops in price (never under your floor), then goes free the day before.",
    when ?? "Text me your move-out date and I'll schedule it.",
    `Say "keep the [item]" for anything you're taking, or "donate the [item]" to skip straight to donation.`,
  ].join("\n");
  return {
    replies: [{ text, parentMessageId: lastMessageId(ctx.batch) }],
    boardPatch: { status: "waiting", currentTask: "Planning Last Call" },
  };
}

/** The selling flow: photo intake, floor price, item-scoped approval. */
async function sell(ctx: ElfContext, text: string): Promise<ElfResult> {
  const events: NonNullable<ElfResult["events"]> = [];
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

  const items = (await ctx.store.listItems(ctx.move.id)).filter(
    (i) => i.intent === "sell" && i.outcome === "listed",
  );
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
  let codes: Record<string, string> = {};
  if (price == null && intake.items.length === 0 && isApproval(text)) {
    justApproved = await approvePendingListings(ctx, text);
    codes = await openDeals(ctx, justApproved);
    for (const it of justApproved)
      events.push({
        type: "listing.approved",
        payload: {
          itemId: it.id,
          name: it.name,
          listPriceCents: it.listPriceCents,
          code: codes[it.id] ?? null,
        },
      });
  }
  const current = await ctx.store.listItems(ctx.move.id);
  const selling = current.filter((i) => i.intent === "sell");
  const needsFloor = selling.filter(
    (i) => i.floorPriceCents == null && i.outcome === "listed" && i.id !== priced?.id,
  );
  const awaiting = selling.filter(
    (i) => i.floorPriceCents != null && !i.listingApproved && i.outcome === "listed",
  );
  const facts = {
    justApproved: justApproved.map((i) => ({
      name: i.name,
      listPrice: i.listPriceCents != null ? fmtUsd(i.listPriceCents) : null,
      code: codes[i.id] ?? null,
    })),
    stillAwaitingApproval: justApproved.length ? awaiting.map((i) => i.name) : [],
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
      reply = template(facts, intake.items, priced, justApproved, codes);
    }
  } else {
    reply = template(facts, intake.items, priced, justApproved, codes);
  }
  if (ctx.signal.aborted) return { replies: [] };

  const working = current
    .filter((i) => i.listingApproved && i.outcome === "listed" && i.intent === "sell")
    .map((i) => i.name);
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
}

function pickTarget(text: string, items: Item[], justIdentified: Item[]): Item | null {
  const named = findItemByText(text, items);
  if (named) return named;
  if (justIdentified.length) return justIdentified[0] ?? null;
  const noFloor = [...items].reverse().find((i) => i.floorPriceCents == null);
  return noFloor ?? items[items.length - 1] ?? null;
}

function template(
  facts: { photosUnreadable: number; itemsStillNeedingAFloor: string[]; stillAwaitingApproval: string[] },
  identified: Item[],
  priced: Item | null,
  approved: Item[],
  codes: Record<string, string>,
): string {
  const lines: string[] = [];
  if (approved.length) {
    lines.push(
      `Listed: ${approved.map((i) => `${i.name} at ${fmtUsd(i.listPriceCents ?? 0)}${codes[i.id] ? ` (buyers text code ${codes[i.id]})` : ""}`).join(", ")}. I'll handle buyers and keep you posted.`,
    );
    if (facts.stillAwaitingApproval[0])
      lines.push(`Want me to list the ${facts.stillAwaitingApproval[0]} too?`);
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
    lines.push("Want me to go ahead and list it?");
  } else if (!lines.length) {
    lines.push("Send me a photo of what you're selling and I'll price it.");
  }
  return lines.join("\n");
}
