import { holdLastCall, isOpen, markOutcome, openDeal, readOwnerDecision } from "@elves/engine";
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
import { handleCounterparty, handleOwnerDecision } from "./deal.ts";
import { moveReport, reportText } from "./impact.ts";
import { CATEGORY_WORDS, type Category, DEFAULT_WEIGHT_LB, extractFactsHeuristic } from "./facts.ts";
import {
  type ApprovedItem,
  anchorDeals,
  approveListings,
  approvePendingListings,
  describeItem,
  fmtUsd,
  identifyFromPhotos,
  isApproval,
  pendingListings,
  REF_ASK,
  wantsListing,
  itemStatus,
  parsePriceCents,
  postLine,
  suggestListCents,
} from "./intake.ts";
import { BUY_SKILL, GREEN_SKILL, pickSkill, type Skill, skillReply } from "./stubs.ts";
import { extractListingUrls } from "./home-followups.ts";

const SYSTEM = `You are the Stuff Elf of Elves, a moving crew the owner texts. You handle everything the owner owns or wants: right now you turn photos into listings, hold a floor price, and handle buyers who text this number so the owner never has to.

Write the reply as a text message:
- Plain text only, 2 to 3 short lines, no markdown, no bullet symbols, at most one emoji (usually none).
- If items were just identified from a photo, say what you see (material, color, condition) and the fair range in one line.
- If the owner gave a floor price, confirm it and the list price you'll use. If their floor is far below the range, say you'll list higher and never go under their floor unless they say so.
- If the owner just approved (justApproved non-empty), confirm it is listed at the list price, then give the line for their marketplace post exactly as written in justApproved.postLine (it carries the ref code buyers quote); say buyers text this number and you'll handle them; then ask nothing.
- Otherwise ask for exactly ONE thing: the lowest price they'd take (if no floor yet); otherwise end with exactly: Want me to list it? Say "list it" and buyers can text this number. If a photo could not be read, ask for a clearer photo.
- Never ask for a photo or a floor price for an item that already has one (see items).
- Buyers reach you by texting this same number; never claim you posted anywhere. You negotiate with them inside the owner's floor and only ask the owner when an offer is under it.
- Do not repeat details already confirmed earlier (see the conversation and working memory).`;

/** "move report", "how did we do", "how much did we save from the landfill". */
const REPORT_ASK =
  /\b(move report|how did we do|how much (?:did we|have we) (?:save|divert|keep)|my impact|landfill report)\b/i;

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
    // Buyers (and sellers, when we buy) talk to the Deal Engine in their own space.
    if (ctx.participant.role !== "owner") return handleCounterparty(ctx);
    const text = batchText(ctx.batch);
    // "keep the couch" holds the price through Last Call, ahead of a pending offer's yes/no.
    const held = await holdLastCall(ctx.store, ctx.move.id, text);
    if (held?.length) {
      const names = held.map((d) => `the ${d.title}`).join(", ");
      return {
        replies: [
          {
            text: `Holding the price on ${names}. Last Call won't drop ${held.length === 1 ? "it" : "them"}.`,
            parentMessageId: lastMessageId(ctx.batch),
          },
        ],
        events: held.map((d) => ({ type: "lastcall.opt_out", payload: { dealId: d.id, title: d.title } })),
        boardPatch: {
          status: "working",
          currentTask: `Holding ${held.map((d) => d.title).join(", ")}`,
          lastUpdate: "Owner opted out of Last Call",
        },
      };
    }
    // "yes" / "no" / "$70" answering a buyer's offer under the floor.
    const decided = await handleOwnerDecision(ctx);
    if (decided) return decided;
    const confirmed = await confirmPending(ctx, text);
    if (confirmed) return confirmed;
    // "what's the ref code?" with nothing left to list: read back the code of every open listing.
    if (
      !hasPhotos(ctx.batch) &&
      REF_ASK.test(text) &&
      !(await pendingListings(ctx.store, ctx.move.id)).length
    ) {
      const codes = await refCodesReply(ctx);
      if (codes) return codes;
    }
    if (!hasPhotos(ctx.batch) && REPORT_ASK.test(text)) {
      const report = moveReport(
        await ctx.store.listItems(ctx.move.id),
        await ctx.store.listDeals(ctx.move.id),
      );
      return replyTo(ctx, reportText(report), {
        events: [
          {
            type: "report.sent",
            payload: { lbDiverted: report.lbDiverted, kgCo2eAvoided: report.kgCo2eAvoided },
          },
        ],
        boardPatch: {
          status: "working",
          currentTask: "Move Report",
          lastUpdate: `${report.lbDiverted} lb diverted so far`,
        },
      });
    }
    if (!hasPhotos(ctx.batch)) {
      const { skill } = pickSkill(text, [SELL_SKILL, BUY_SKILL, GREEN_SKILL]);
      if (skill === BUY_SKILL) {
        const buy = await startBuy(ctx, text);
        if (buy) return buy;
      }
      if (
        skill === GREEN_SKILL &&
        /\b(donat(?:e|ion|ing)?|trash|dump|311|give away|goodwill|curb)\b/i.test(text)
      ) {
        const donated = await askDonate(ctx, text);
        if (donated) return donated;
      }
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

    // "selling a desk" said straight to Stuff: capture the item here too, so it never vanishes between Elves.
    let items = await ctx.store.listItems(ctx.move.id);
    if (!hasPhotos(ctx.batch)) {
      for (const it of extractFactsHeuristic(text, ctx.now()).items) {
        if (it.intent !== "sell" && it.intent !== "unknown") continue;
        if (items.some((e) => e.name.toLowerCase() === it.name.toLowerCase())) continue;
        await ctx.store.upsertItem({
          moveId: ctx.move.id,
          name: it.name,
          category: it.category,
          weightLb: DEFAULT_WEIGHT_LB[it.category],
          listPriceCents: null,
          floorPriceCents: null,
          outcome: "listed",
        });
        events.push({
          type: "item.captured",
          payload: { name: it.name, category: it.category, intent: it.intent },
        });
      }
      items = await ctx.store.listItems(ctx.move.id);
    }
    const price = parsePriceCents(text);
    let priced: Item | null = null;
    if (price != null && items.length) {
      const target = pickTarget(text, items, intake.items);
      // "list it at 200" on an item that already has a floor names the list price, not a new floor.
      if (target && !(wantsListing(text) && target.floorPriceCents != null)) {
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

    let justApproved: ApprovedItem[] = [];
    if (wantsListing(text)) {
      // "list it for at least 1200": the floor just set, listed in the same breath. Otherwise whatever is waiting,
      // even when a new photo came in the same text (the new item has no floor yet, so it is not among them).
      justApproved = priced
        ? await approveListings(ctx, [priced], text)
        : await approvePendingListings(ctx, text);
      for (const it of justApproved)
        events.push({
          type: "listing.approved",
          payload: {
            itemId: it.id,
            name: it.name,
            listPriceCents: it.listPriceCents,
            dealId: it.dealId,
            code: it.dealCode,
          },
        });
    }
    const poolNumber = ctx.batch.messages[0]?.agentHandle ?? null;
    const current = await ctx.store.listItems(ctx.move.id);
    const needsFloor = current.filter((i) => i.floorPriceCents == null && i.id !== priced?.id);
    // "list it" with nothing to list: say exactly what is missing instead of letting the model talk around it.
    if (
      wantsListing(text) &&
      !justApproved.length &&
      !priced &&
      !intake.items.length &&
      !hasPhotos(ctx.batch)
    ) {
      const unlisted = needsFloor.filter((i) => i.outcome === "listed");
      if (!current.length)
        return replyTo(
          ctx,
          "📦 What are you selling?\n\nSend a photo and the lowest you'd take, and I'll list it and text you the ref code buyers quote.",
          {
            boardPatch: {
              status: "working",
              currentTask: "Waiting on a photo",
              lastUpdate: "Asked what to list",
            },
          },
        );
      if (unlisted.length)
        return replyTo(
          ctx,
          `❓ What's the lowest you'd take for the ${unlisted.map((i) => i.name).join(" and the ")}?\n\nThen I'll list it and send you the ref code.`,
          {
            boardPatch: {
              status: "working",
              currentTask: `Waiting on a floor for ${unlisted.map((i) => i.name).join(", ")}`,
              lastUpdate: "Asked for the floor",
            },
          },
        );
    }
    const facts = {
      justApproved: justApproved.map((i) => ({
        name: i.name,
        listPrice: i.listPriceCents != null ? fmtUsd(i.listPriceCents) : null,
        ref: i.dealCode,
        postLine: postLine(i, poolNumber),
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
        reply = template(facts, intake.items, priced, justApproved, poolNumber);
      }
    } else {
      reply = template(facts, intake.items, priced, justApproved, poolNumber);
    }
    if (ctx.signal.aborted) return { replies: [] };
    // A blank draft is never sent (Photon refuses it with a 422); the template says the same thing.
    if (!reply.trim()) reply = template(facts, intake.items, priced, justApproved, poolNumber);
    // An LLM draft may paraphrase; the post line with the ref code must survive verbatim.
    for (const a of justApproved)
      if (!reply.includes(a.dealCode)) reply += `\nFor your post: ${postLine(a, poolNumber)}`;

    const working = current.filter((i) => i.outcome === "listed").map((i) => i.name);
    return {
      replies: [
        { text: reply, parentMessageId: lastMessageId(ctx.batch), onSent: anchorDeals(ctx, justApproved) },
      ],
      events,
      boardPatch: {
        status: "working",
        currentTask: working.length ? `Listing ${working.join(", ")}` : "Waiting on a photo",
        lastUpdate: justApproved.length
          ? `Listed ${justApproved.map((i) => `${i.name} (ref ${i.dealCode})`).join(", ")}; buyers text this number`
          : priced
            ? `Floor ${fmtUsd(priced.floorPriceCents ?? 0)} on the ${priced.name}`
            : intake.items.length
              ? `Identified ${intake.items.map((i) => i.name).join(", ")}`
              : "Replied to the owner",
      },
    };
  },
};

type Pending =
  | { kind: "donate"; itemId: string; name: string }
  | { kind: "buy"; url: string; maxCents: number | null };

async function readPending(ctx: ElfContext): Promise<Pending | null> {
  const events = await ctx.store.listEvents(ctx.move.id);
  let pending: Pending | null = null;
  for (const e of events) {
    if (e.type === "donate.pending") {
      const itemId = String(e.payload.itemId ?? "");
      const name = String(e.payload.name ?? "item");
      if (itemId) pending = { kind: "donate", itemId, name };
    } else if (e.type === "buy.pending") {
      pending = {
        kind: "buy",
        url: String(e.payload.url ?? ""),
        maxCents: typeof e.payload.maxCents === "number" ? e.payload.maxCents : null,
      };
    } else if (e.type === "donate.booked" || e.type === "buy.opened") pending = null;
  }
  return pending;
}

function replyTo(ctx: ElfContext, text: string, extra: Partial<ElfResult> = {}): ElfResult {
  return {
    replies: [{ text, parentMessageId: lastMessageId(ctx.batch) }],
    boardPatch: { status: "working", currentTask: "Stuff" },
    ...extra,
  };
}

/** "yes" after a buy ceiling or a donate ask. An offer under the floor is handled earlier. */
async function confirmPending(ctx: ElfContext, text: string): Promise<ElfResult | null> {
  if (readOwnerDecision(text)?.kind !== "yes") return null;
  const pending = await readPending(ctx);
  if (!pending) return null;
  if (pending.kind === "donate") {
    const deals = await ctx.store.listDeals(ctx.move.id);
    const deal = deals.find((d) => d.subjectId === pending.itemId && d.mode === "sell_item");
    if (deal) await markOutcome(ctx.store, deal.id, "donated");
    else {
      const item = (await ctx.store.listItems(ctx.move.id)).find((i) => i.id === pending.itemId);
      if (item)
        await ctx.store.upsertItem({
          id: item.id,
          moveId: item.moveId,
          name: item.name,
          category: item.category,
          outcome: "donated",
        });
    }
    return replyTo(ctx, `Booking a donation pickup for the ${pending.name}. It won't go on the truck.`, {
      events: [
        { type: "donate.booked", payload: { itemId: pending.itemId, name: pending.name } },
        { type: "pickup.requested", payload: { itemId: pending.itemId, kinds: ["donation"] } },
      ],
      boardPatch: {
        status: "working",
        currentTask: `Donating ${pending.name}`,
        lastUpdate: "Donation booked",
      },
    });
  }
  if (!pending.url || pending.maxCents == null) return null;
  const deal = await openDeal(ctx.store, {
    moveId: ctx.move.id,
    mode: "buy_item",
    subjectId: null,
    title: hostOf(pending.url),
    askCents: pending.maxCents,
    limitCents: pending.maxCents,
  });
  return replyTo(
    ctx,
    `Ceiling set at ${fmtUsd(pending.maxCents)} for ${pending.url} (ref ${deal.code}). I won't go over it. When the seller texts this number with that ref, I'll make the offer.`,
    {
      events: [
        {
          type: "buy.opened",
          payload: { dealId: deal.id, code: deal.code, url: pending.url, maxCents: pending.maxCents },
        },
      ],
      boardPatch: {
        status: "working",
        currentTask: `Buying ${hostOf(pending.url)}`,
        lastUpdate: `Ceiling ${fmtUsd(pending.maxCents)} (ref ${deal.code})`,
      },
    },
  );
}

async function startBuy(ctx: ElfContext, text: string): Promise<ElfResult | null> {
  const pending = await readPending(ctx);
  const url = extractListingUrls(text)[0] ?? (pending?.kind === "buy" ? pending.url : "");
  const max = parsePriceCents(text) ?? (pending?.kind === "buy" ? pending.maxCents : null);
  if (!url)
    return replyTo(
      ctx,
      "Forward the listing link and the most you'll pay. I won't send an offer until you say yes.",
    );
  if (max == null)
    return replyTo(ctx, `What's the most you'll pay for ${url}?`, {
      events: [{ type: "buy.pending", payload: { url, maxCents: null } }],
    });
  return replyTo(
    ctx,
    `I'll cap the offer at ${fmtUsd(max)} for ${url}. Say yes and I'll set that ceiling. I won't contact them until you do.`,
    { events: [{ type: "buy.pending", payload: { url, maxCents: max } }] },
  );
}

async function askDonate(ctx: ElfContext, text: string): Promise<ElfResult | null> {
  const items = await ctx.store.listItems(ctx.move.id);
  const named = namedItem(text, items);
  const target = named ?? (items.length === 1 ? items[0]! : null);
  if (!target)
    return replyTo(
      ctx,
      items.length
        ? `Which one should I donate: ${items.map((i) => i.name).join(", ")}?`
        : "Which item should I donate? A name is enough, and I'll book the pickup once you say yes.",
    );
  return replyTo(
    ctx,
    `Say yes and I'll book a donation pickup for the ${target.name}. Nothing goes out until you do.`,
    {
      events: [{ type: "donate.pending", payload: { itemId: target.id, name: target.name } }],
      boardPatch: {
        status: "waiting",
        currentTask: `Donate ${target.name}?`,
        lastUpdate: "Waiting on a yes",
      },
    },
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "listing";
  }
}

function namedItem(text: string, items: Item[]): Item | null {
  const t = text.toLowerCase();
  const byName = items.find((i) => t.includes(i.name.toLowerCase()));
  if (byName) return byName;
  for (const [cat, words] of Object.entries(CATEGORY_WORDS) as [Category, string[]][]) {
    if (words.some((w) => new RegExp(`(^|[^a-z])${w}(es|s)?([^a-z]|$)`).test(t))) {
      const m = items.find((i) => i.category === cat);
      if (m) return m;
    }
  }
  return null;
}

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
  approved: ApprovedItem[],
  poolNumber: string | null,
): string {
  const lines: string[] = [];
  if (approved.length) {
    lines.push(
      `Listed: ${approved.map((i) => `${i.name} at ${fmtUsd(i.listPriceCents ?? 0)}`).join(", ")}. Buyers text this number and I'll handle them inside your floor.`,
    );
    for (const a of approved) lines.push(`For your post: ${postLine(a, poolNumber)}`);
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

/** The ref code and post line of every open listing, so the owner can hand them to a buyer any time. */
async function refCodesReply(ctx: ElfContext): Promise<ElfResult | null> {
  const items = await ctx.store.listItems(ctx.move.id);
  const open = (await ctx.store.listDeals(ctx.move.id)).filter(
    (d) => d.mode === "sell_item" && isOpen(d.state),
  );
  const poolNumber = ctx.batch.messages[0]?.agentHandle ?? null;
  const lines = open.flatMap((d) => {
    const item = items.find((i) => i.id === d.subjectId);
    if (!item) return [];
    return [
      `• ${item.name}: ${d.code}\n  ${postLine({ ...item, dealId: d.id, dealCode: d.code }, poolNumber)}`,
    ];
  });
  if (!lines.length)
    return replyTo(
      ctx,
      items.some((i) => i.outcome === "listed")
        ? "No listing is live yet, so there's no ref code to give out.\n\nSend a photo and the lowest you'd take, then say \"list it\" and the code comes back with the post line."
        : "Nothing is listed yet, so there's no ref code to give out.\n\nSend a photo of what you're selling and the lowest you'd take.",
      {
        boardPatch: {
          status: "working",
          currentTask: "Waiting on a photo",
          lastUpdate: "Asked for a ref code; nothing listed",
        },
      },
    );
  return replyTo(
    ctx,
    [
      "📦 Ref codes for your listings:",
      lines.join("\n"),
      "Buyers text this number and mention the code; I take it from there.",
    ].join("\n\n"),
    {
      boardPatch: {
        status: "working",
        currentTask: `Listing ${lines.length} item${lines.length === 1 ? "" : "s"}`,
        lastUpdate: "Read the ref codes back",
      },
    },
  );
}
