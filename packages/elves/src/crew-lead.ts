import { ELF_LABELS } from "@elves/shared";
import {
  batchText,
  type Elf,
  type ElfContext,
  type ElfResult,
  hasPhotos,
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
import { abilitiesReply, crewIntro, crewScopePrompt, isCapabilitiesQuestion, outOfScope } from "./crew.ts";
import { homeElf } from "./home.ts";
import { handleOnboarding } from "./onboarding.ts";
import { delegatesFor } from "./router.ts";
import { stuffElf } from "./sell.ts";

const SYSTEM = `You are the Crew Lead of Elves, a moving crew the owner texts on iMessage or SMS. You run the owner's chat and hand work to three specialist Elves. You are not a general assistant: you only talk about this move and only offer what the crew can actually do.

${crewScopePrompt()}

Your job each turn:
1. Capture what the owner told you (dates, addresses, items) and confirm it in their own words.
2. Say which Elf is on what, in one line. Mention ONLY the Elves listed under elvesWithWork in the facts; if that list is empty, mention no Elf. Never invent work for an Elf.
3. Ask for at most ONE missing thing (see "Asking" below).

Scope rules (these override everything else):
- If the facts include cantDo, the owner asked for something the crew does not do. Open with cantDo.cant word for word, then cantDo.instead. Never offer to do it anyway, never say "I'll look into it", and never suggest an outside company or app by name.
- If the owner asks for anything else that is not in the list above, say plainly in one line that the crew can't do that, then name the closest thing it can do from the list. Never improvise a new ability, and never promise one "later".
- If the owner asks what you can do, list the abilities above, one short line each, then the line about what the crew can't do.
- Never promise to move money, post to a marketplace, book a viewing or a pickup, or agree a price without the owner's yes. Every Elf drafts and asks; the owner decides.

Asking: if the move-out date is unknown, ask for it. Otherwise, if an item has a photo but no floor (see items), ask for the lowest price they'd take for it. Otherwise, if an item for sale has no photo, ask for a photo and the lowest price. Never ask for a photo or a floor an item already has. Never ask about trucks, movers or anything the crew doesn't do.

Facts you may see:
- firstContact: the crew intro with the full ability list is sent right above your reply, so do not introduce yourself or list the abilities again; just respond to what they said.
- identifiedFromPhotos: say in one line what the photo shows (material, color, condition) and the fair price range; the Stuff Elf has it.
- justApproved: confirm those items are listed at their list price and that buyers will text this number.
- photosUnreadable: ask them to send the photo again.

Write the reply as a text message:
- Plain text only. No markdown, no bullet symbols, no headers. At most one emoji, usually none.
- 2 to 4 short lines, one sentence each (an ability list may run longer).
- Do not repeat facts you already confirmed in earlier turns (see the conversation and working memory). Answer questions about the move from working memory. If they want the full picture, tell them to text "status".`;

export const crewLead: Elf = {
  name: "crew_lead",
  description:
    'Orchestration: greetings, what the crew can do, "status", the plan, move-out and move-in dates, addresses, roommates, general questions about the move, anything ambiguous, and anything the crew does not do (trucks, movers, U-Haul, move day, leases, landlords, paying anyone)',
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
    const asked = batchText(ctx.batch);
    const parent = lastMessageId(ctx.batch);
    // "what can you do?" has an exact answer, during onboarding too; it does not move the call along.
    // ("status" belongs to the Home Elf, see router.ts.)
    if (!ctx.firstContact && !hasPhotos(ctx.batch) && isCapabilitiesQuestion(asked))
      return { replies: [{ text: abilitiesReply(), parentMessageId: parent }] };
    // The onboarding call runs first: gather, play the brief back, dispatch on the owner's yes.
    const onboarding = await handleOnboarding(ctx);
    if (onboarding) return onboarding;
    const text = asked;
    // A text that asks for Stuff and Home at once: call each, in order, and send each one's reply.
    const both = [stuffElf, homeElf].filter((e) => delegatesFor(text, [e]).length);
    if (both.length === 2 && !ctx.firstContact && !hasPhotos(ctx.batch)) return callElves(ctx, both);
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
      justApproved = await approvePendingListings(ctx, text);
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
    const cantDo = outOfScope(text);
    const summary = {
      firstContact: ctx.firstContact,
      cantDo: cantDo ? { cant: cantDo.cant, instead: cantDo.instead } : null,
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
    // The first text always opens with exactly what the crew can do, word for word, never "text me anything".
    if (ctx.firstContact) reply = `${crewIntro()}\n\n${reply}`;

    const poolNumber = ctx.batch.messages[0]?.agentHandle ?? null;
    for (const a of justApproved)
      if (!reply.includes(a.dealCode)) reply += `\nFor your post: ${postLine(a, poolNumber)}`;
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
  cantDo: { cant: string; instead: string } | null;
  moveOutDate: string | null;
  itemsMentionedNow: { name: string; intent: string }[];
  allItems: string[];
  identifiedFromPhotos: string[];
  photosUnreadable: number;
  justApproved: string[];
  items: { name: string; hasPhoto: boolean; floor: string | null; listPrice: string | null }[];
}): string {
  const lines: string[] = [];
  if (s.cantDo) lines.push(`${s.cantDo.cant} ${s.cantDo.instead}`);
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

/**
 * The Crew Lead calls other Elves as the work needs them. Each one handles the same batch and its replies go out in
 * order; each one's board row is patched by the Crew Lead, since the service only patches the Elf it routed to.
 */
async function callElves(ctx: ElfContext, elves: Elf[]): Promise<ElfResult> {
  const out: ElfResult = { replies: [], events: [], outbound: [], movePatch: {} };
  for (const elf of elves) {
    if (ctx.signal.aborted) break;
    const r = await elf.handle(ctx);
    out.replies.push(...r.replies);
    out.events!.push(...(r.events ?? []));
    out.outbound!.push(...(r.outbound ?? []));
    Object.assign(out.movePatch!, r.movePatch ?? {});
    if (r.boardPatch) await ctx.store.patchBoard(ctx.move.id, elf.name, r.boardPatch);
  }
  return out;
}
