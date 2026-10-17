import { ELF_LABELS } from "@elves/shared";
import {
  batchText,
  type Elf,
  type ElfContext,
  type ElfResult,
  lastMessageId,
  memoryPreamble,
} from "./contract.ts";
import { DEFAULT_WEIGHT_LB, ExtractedFacts, extractFactsHeuristic, formatDate } from "./facts.ts";
import {
  anchorDeals,
  approvePendingListings,
  describeItem,
  identifyFromPhotos,
  isApproval,
  itemStatus,
  postLine,
} from "./intake.ts";

const SYSTEM = `You are the Crew Lead of Elves, a moving crew the owner texts. Four specialist Elves work under you: Stuff (selling, buying, donating), Money (payments, escrow, splits), Move-day (trucks, storage, the Move Map) and Home (lease, finding a place, move-in week). You run the owner's group chat.

Write the reply as a text message:
- Plain text only. No markdown, no bullet symbols, no headers. At most one emoji, usually none.
- 2 to 4 short lines. Each line is one sentence.
- Confirm what you captured (dates, items, addresses) in the owner's own words.
- Say which Elf is on what, in one line. Mention ONLY the Elves listed under elvesWithWork in the facts; if that list is empty, mention no Elf. Never invent work for an Elf.
- If identifiedFromPhotos is non-empty, say in one line what the photo shows (material, color, condition) and the fair price range; the Stuff Elf has it.
- Ask for at most ONE missing thing. If the move-out date is unknown, ask for it. Otherwise, if an item has a photo but no floor (see items), ask for the lowest price they'd take for it. Otherwise, if an item for sale has no photo, ask for a photo and the lowest price. Never ask for a photo or a floor an item already has.
- If justApproved is non-empty, confirm those items are listed at their list price and that buyers will text this number.
- Never promise to move money, post to a marketplace, or book anything without the owner's OK.
- If this is the first contact, open with one line saying you're their moving crew and they can text you anything about the move.
- Do not repeat facts you already confirmed in earlier turns (see the conversation and working memory). Answer questions about the move from working memory.`;

export const crewLead: Elf = {
  name: "crew_lead",
  description:
    "Orchestration: greetings, the plan, move-out and move-in dates, addresses, roommates, coverage, general questions about the move, anything ambiguous",
  keywords: [
    "hi",
    "hello",
    "hey",
    "plan",
    "status",
    "moving out",
    "moving in",
    "move out",
    "move in",
    "move-out",
    "move-in",
    "date",
    "roommate",
    "cover",
    "covering",
    "help",
    "thanks",
    "thank you",
  ],

  async handle(ctx: ElfContext): Promise<ElfResult> {
    const text = batchText(ctx.batch);
    const now = ctx.now();
    const heuristic = extractFactsHeuristic(text, now);
    const extraction = (async () => {
      if (ctx.llm.name === "fake") return heuristic;
      try {
        const llmFacts = await ctx.llm.extract(ExtractedFacts, {
          system:
            `Extract moving facts from an owner's text messages. Today is ${now.toISOString().slice(0, 10)}. ` +
            "Resolve relative dates to ISO dates. Only include items the owner actually mentions. Use null when unknown.",
          user: text,
        });
        return {
          ...llmFacts,
          moveOutDate: llmFacts.moveOutDate ?? heuristic.moveOutDate,
          items: llmFacts.items.length ? llmFacts.items : heuristic.items,
        };
      } catch (err) {
        ctx.log.warn("fact extraction failed; using heuristic", { error: String(err) });
        return heuristic;
      }
    })();
    // Fact extraction and photo identification are independent; run them together.
    const [facts, intake] = await Promise.all([extraction, identifyFromPhotos(ctx)]);
    if (ctx.signal.aborted) return { replies: [] };

    const movePatch: ElfResult["movePatch"] = {};
    const events: ElfResult["events"] = [];
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
    let justApproved: Awaited<ReturnType<typeof approvePendingListings>> = [];
    if (intake.items.length === 0 && isApproval(text)) {
      justApproved = await approvePendingListings(ctx);
      for (const it of justApproved)
        events.push({
          type: "listing.approved",
          payload: { itemId: it.id, name: it.name, listPriceCents: it.listPriceCents, dealId: it.dealId, code: it.dealCode },
        });
    }
    if (facts.moveOutDate && facts.moveOutDate !== ctx.move.moveOutAt) {
      movePatch.moveOutAt = facts.moveOutDate;
      events.push({ type: "move.date_captured", payload: { kind: "move_out", date: facts.moveOutDate } });
    }
    if (facts.moveInDate && facts.moveInDate !== ctx.move.moveInAt) {
      movePatch.moveInAt = facts.moveInDate;
      events.push({ type: "move.date_captured", payload: { kind: "move_in", date: facts.moveInDate } });
    }
    if (facts.fromAddress && !ctx.move.fromAddress) movePatch.fromAddress = facts.fromAddress;
    if (facts.toAddress && !ctx.move.toAddress) movePatch.toAddress = facts.toAddress;

    const existing = await ctx.store.listItems(ctx.move.id);
    const newItems: string[] = [];
    for (const it of facts.items) {
      if (existing.some((e) => e.name.toLowerCase() === it.name.toLowerCase())) continue;
      await ctx.store.upsertItem({
        moveId: ctx.move.id,
        name: it.name,
        category: it.category,
        weightLb: DEFAULT_WEIGHT_LB[it.category],
        listPriceCents: null,
        floorPriceCents: null,
        outcome: "listed",
      });
      newItems.push(it.name);
      events.push({
        type: "item.captured",
        payload: { name: it.name, category: it.category, intent: it.intent },
      });
    }
    const sellItems = facts.items.filter((i) => i.intent === "sell" || i.intent === "unknown");
    for (const it of intake.items) {
      if (!sellItems.some((s) => s.name === it.name))
        sellItems.push({
          name: it.name,
          category: it.category as (typeof facts.items)[number]["category"],
          intent: "sell",
        });
    }
    if (sellItems.length) {
      await ctx.store.patchBoard(ctx.move.id, "stuff", {
        status: "working",
        currentTask: `Listing ${sellItems.map((i) => i.name).join(", ")}`,
        lastUpdate: facts.moveOutDate
          ? `Waiting on a photo and a floor price; Last Call starts 48h before ${formatDate(facts.moveOutDate)}`
          : "Waiting on a photo and a floor price",
      });
    } else if (facts.moveOutDate) {
      await ctx.store.patchBoard(ctx.move.id, "stuff", {
        status: "waiting",
        currentTask: `Last Call starts 48h before ${formatDate(facts.moveOutDate)}`,
      });
    }

    const moveOut = movePatch.moveOutAt ?? ctx.move.moveOutAt;
    const elvesWithWork: string[] = [];
    const stuffWork: string[] = [];
    if (sellItems.length) stuffWork.push(`sell ${sellItems.map((i) => i.name).join(", ")}`);
    if (facts.items.some((i) => i.intent === "donate")) stuffWork.push("donation pickup");
    if (facts.items.some((i) => i.intent === "buy")) stuffWork.push("evaluate what to buy");
    if (stuffWork.length) elvesWithWork.push(`Stuff Elf: ${stuffWork.join("; ")}`);
    const summary = {
      firstContact: ctx.firstContact,
      elvesWithWork,
      identifiedFromPhotos: intake.items.map(describeItem),
      photosUnreadable: intake.failed,
      justApproved: justApproved.map((i) => i.name),
      items: itemStatus(await ctx.store.listItems(ctx.move.id)),
      moveOutDate: moveOut,
      moveInDate: movePatch.moveInAt ?? ctx.move.moveInAt,
      itemsMentionedNow: facts.items,
      allItems: [...existing.map((e) => e.name), ...newItems],
      asks: facts.asks,
      roommates: facts.roommates,
    };

    let reply: string;
    if (ctx.llm.name !== "fake") {
      try {
        reply = await ctx.llm.draft({
          system: SYSTEM,
          user: `${memoryPreamble(ctx.conversation)}\n\nFacts captured this turn (JSON):\n${JSON.stringify(summary)}\n\nOwner's latest message(s):\n"""${text}"""\n\nWrite the reply.`,
          maxTokens: 400,
        });
      } catch (err) {
        ctx.log.warn("draft failed; using template", { error: String(err) });
        reply = templateReply(summary);
      }
    } else {
      reply = templateReply(summary);
    }
    if (ctx.signal.aborted) return { replies: [] };

    const poolNumber = ctx.batch.messages[0]?.agentHandle ?? null;
    for (const a of justApproved) if (!reply.includes(a.dealCode)) reply += `\nFor your post: ${postLine(a, poolNumber)}`;
    const replies: ElfResult["replies"] = [
      { text: reply, parentMessageId: lastMessageId(ctx.batch), onSent: anchorDeals(ctx, justApproved) },
    ];
    if (ctx.publicUrl && !ctx.move.boardLinkSent && !ctx.firstContact) {
      replies.push({ text: `Crew Board (live): ${ctx.publicUrl}/b/${ctx.move.id}`, parentMessageId: null });
      movePatch.boardLinkSent = true;
    }

    const working = sellItems.length ? [ELF_LABELS.stuff] : [];
    return {
      replies,
      movePatch,
      events,
      boardPatch: {
        status: "working",
        currentTask: moveOut ? `Move-out ${formatDate(moveOut)}` : "Waiting on the move-out date",
        lastUpdate: working.length
          ? `Handed ${newItems.length || sellItems.length} item(s) to ${working.join(", ")}`
          : "Replied to the owner",
      },
    };
  },
};

function templateReply(s: {
  firstContact: boolean;
  moveOutDate: string | null;
  itemsMentionedNow: { name: string; intent: string }[];
  allItems: string[];
  identifiedFromPhotos: string[];
  photosUnreadable: number;
  justApproved: string[];
  items: { name: string; hasPhoto: boolean; floor: string | null; listPrice: string | null }[];
}): string {
  const lines: string[] = [];
  if (s.firstContact)
    lines.push(
      "Hey, this is your moving crew. Text me anything about the move and I'll put the right Elf on it.",
    );
  if (s.identifiedFromPhotos.length)
    lines.push(`From your photo: ${s.identifiedFromPhotos.join("; ")}. Stuff Elf has it.`);
  else if (s.photosUnreadable) lines.push("I couldn't read the photo you sent; can you send it again?");
  const got: string[] = [];
  if (s.moveOutDate) got.push(`move-out ${formatDate(s.moveOutDate)}`);
  const sell = s.itemsMentionedNow
    .filter((i) => i.intent === "sell" || i.intent === "unknown")
    .map((i) => i.name);
  if (sell.length) got.push(`${sell.join(" and ")} to sell`);
  if (got.length) lines.push(`Got it: ${got.join(", ")}.`);
  if (sell.length) lines.push(`Stuff Elf is on the ${sell.join(" and ")}.`);
  if (s.justApproved.length) lines.push(`Listed: ${s.justApproved.join(", ")}. Buyers text this number.`);
  const needsFloor = s.items.find((i) => i.hasPhoto && !i.floor);
  const needsPhoto = s.items.find((i) => !i.hasPhoto);
  if (!s.moveOutDate) lines.push("When's your move-out date?");
  else if (needsFloor) lines.push(`What's the lowest you'd take for the ${needsFloor.name}?`);
  else if (needsPhoto)
    lines.push(
      `Send a photo of the ${needsPhoto.name} and the lowest price you'd take, and I'll get it listed.`,
    );
  else if (!s.justApproved.length && !s.items.length) lines.push("What should the crew start on?");
  return lines.join("\n");
}
