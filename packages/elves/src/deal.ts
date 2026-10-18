import {
  counterpartyTurn,
  dealBoard,
  type EngineMessage,
  isOpen,
  ownerTurn,
  partyForText,
  policyFor,
  price,
  type TurnResult,
  whichListing,
} from "@elves/engine";
import type { DealParty } from "@elves/shared";
import {
  batchText,
  type ElfContext,
  type ElfOutbound,
  type ElfReply,
  type ElfResult,
  lastMessageId,
  memoryPreamble,
} from "./contract.ts";

/**
 * The Elf side of the Deal Engine: the engine decides (price, slot, state), this file says it. Counterparty
 * replies may be redrafted by the model from buyer-safe facts, and a draft that introduces a dollar amount the
 * engine did not choose is thrown away. Owner summaries are the engine's own words, threaded under the deal.
 */

const COUNTERPARTY_SYSTEM = `You are an Elf on a moving crew, texting with someone about a deal the crew is handling for its owner (selling or buying an item, or a room). You speak for the crew, not as the owner.

Rewrite the draft reply as one text message:
- Plain text, 1 to 2 short lines, no markdown, no emoji.
- Keep every price, time, slot number and address in the draft exactly as written. Never add a price, discount, time or promise that is not in the draft.
- If their message asked a simple question about the item and the listing facts answer it (condition, size, color), answer it in a few words, then say the draft's point.
- Payment only ever goes through Elves escrow; never suggest cash apps, checks or wires.
- Never mention the owner's name, phone number, move date, reasons for moving, or anything under "Confidential".`;

const DOLLARS = /\$\s?\d[\d,]*(?:\.\d{1,2})?/g;

/** A redraft may only use dollar amounts the engine already chose. */
export function keepsNumbers(template: string, draft: string): boolean {
  const allowed = new Set((template.match(DOLLARS) ?? []).map((d) => d.replace(/[\s,]/g, "")));
  return (draft.match(DOLLARS) ?? []).every((d) => allowed.has(d.replace(/[\s,]/g, "")));
}

async function voice(ctx: ElfContext, m: EngineMessage, theirText: string): Promise<string> {
  if (ctx.llm.name === "fake" || m.to !== "counterparty") return m.text;
  try {
    const draft = await ctx.llm.draft({
      system: COUNTERPARTY_SYSTEM,
      user: `${memoryPreamble(ctx.conversation)}\n\nListing facts (JSON):\n${JSON.stringify(m.facts)}\n\nTheir latest message(s):\n"""${theirText}"""\n\nDraft reply (keep its numbers):\n"""${m.text}"""\n\nWrite the text.`,
      maxTokens: 200,
    });
    if (draft && keepsNumbers(m.text, draft)) return draft;
    ctx.log.warn("deal draft changed the numbers; using the engine's words", { kind: m.kind });
  } catch (err) {
    ctx.log.warn("deal draft failed; using the engine's words", { error: String(err) });
  }
  return m.text;
}

/** Turn the engine's messages into replies (this space) and outbound texts (other spaces). */
async function deliver(ctx: ElfContext, r: TurnResult, here: { partyId: string | null }): Promise<ElfResult> {
  const text = batchText(ctx.batch);
  const inOwnerChat = ctx.participant.role === "owner";
  const replies: ElfReply[] = [];
  const outbound: ElfOutbound[] = [];
  const parties = new Map<string, DealParty>();
  const partyOf = async (id: string) => {
    if (!parties.has(id)) {
      const all = await ctx.store.listDealParties(r.deal.id);
      for (const p of all) parties.set(p.id, p);
      if (!parties.has(id))
        for (const d of await ctx.store.listDeals(ctx.move.id))
          for (const p of await ctx.store.listDealParties(d.id)) parties.set(p.id, p);
    }
    return parties.get(id);
  };

  for (const m of r.messages) {
    const onSent = async (messageId: string) => {
      if (m.askFor) {
        const fresh = (await ctx.store.listDealParties(m.dealId)).find((x) => x.id === m.askFor);
        if (fresh) await ctx.store.upsertDealParty({ ...fresh, ownerAskMessageId: messageId });
      }
      if (m.to === "owner") {
        const deal = await ctx.store.getDeal(m.dealId);
        if (deal && !deal.ownerThreadId) await ctx.store.upsertDeal({ ...deal, ownerThreadId: messageId });
      }
    };
    if (m.to === "counterparty") {
      if (!inOwnerChat && m.partyId === here.partyId) {
        replies.push({ text: await voice(ctx, m, text), parentMessageId: lastMessageId(ctx.batch) });
      } else if (m.partyId) {
        const p = await partyOf(m.partyId);
        if (p) outbound.push({ spaceId: p.spaceId, text: m.text, parentMessageId: null });
      }
    } else if (inOwnerChat) {
      replies.push({ text: m.text, parentMessageId: lastMessageId(ctx.batch), onSent });
    } else {
      const deal = m.dealId === r.deal.id ? r.deal : await ctx.store.getDeal(m.dealId);
      outbound.push({ spaceId: ctx.move.ownerSpaceId, text: m.text, parentMessageId: deal?.ownerThreadId ?? null, onSent });
    }
  }

  const board = await dealBoard(ctx.store, ctx.move.id, ["sell_item", "buy_item"]);
  const latest = r.messages.find((m) => m.to === "owner");
  return {
    replies,
    outbound,
    events: r.events,
    boardPatch: {
      status: r.deal.state === "scheduled" ? "waiting" : "working",
      currentTask: board ? `Deals: ${board}` : `Deal on the ${r.deal.title}`,
      ...(latest ? { lastUpdate: latest.text.slice(0, 160) } : {}),
    },
  };
}

/** A buyer (or seller, applicant, lister) texting in their own space. */
export async function handleCounterparty(ctx: ElfContext): Promise<ElfResult> {
  const text = batchText(ctx.batch);
  const last = ctx.batch.messages[ctx.batch.messages.length - 1];
  const hadParties = (await ctx.store.listDealPartiesBySpace(ctx.participant.spaceId)).length > 0;
  const party = await partyForText(ctx.store, ctx.participant.spaceId, text, {
    handle: ctx.participant.handle,
    platform: ctx.participant.platform,
    agentUserId: last?.agentId ?? ctx.participant.agentUserId,
  });
  if (!party) {
    // A stranger who has not picked a listing yet: say what is on offer (names and asking prices only).
    if (!(await ctx.store.listDealPartiesBySpace(ctx.participant.spaceId)).length) {
      const options = await whichListing(ctx.store, ctx.move.id, ctx.participant.spaceId);
      if (options.length) {
        const list = options
          .map((d, i) => `${i + 1}) ${d.title}, ${price(d.askCents, policyFor(d.mode).unit)}`)
          .join("\n");
        return {
          replies: [
            {
              text: `Hi! Which one are you asking about?\n${list}\nReply with the name or the number.`,
              parentMessageId: lastMessageId(ctx.batch),
            },
          ],
          events: [
            {
              type: "inquiry.asked",
              payload: { spaceId: ctx.participant.spaceId, dealIds: options.map((d) => d.id) },
            },
          ],
        };
      }
    }
    const titles: string[] = [];
    for (const row of await ctx.store.listDealPartiesBySpace(ctx.participant.spaceId)) {
      const deal = await ctx.store.getDeal(row.dealId);
      if (deal && isOpen(deal.state)) titles.push(`the ${deal.title}`);
    }
    const which =
      titles.length > 1
        ? `You have open talks on ${titles.join(" and ")}. Which one?`
        : "Hi! Which listing are you asking about? The ref code in the post (like K7Q2) helps me find it.";
    return {
      replies: [{ text: which, parentMessageId: lastMessageId(ctx.batch) }],
    };
  }
  // A bare "2" that only picked a listing from our "which one?" list is not a $2 offer.
  const picked = !hadParties && /^#?\d{1,2}[.)]?$/.test(text.trim());
  const r = await counterpartyTurn({
    store: ctx.store,
    move: ctx.move,
    party,
    text: picked ? "is it still available?" : text,
    clock: { now: ctx.now() },
  });
  if (ctx.signal.aborted) return { replies: [] };
  return deliver(ctx, r, { partyId: party.id });
}

/** The owner answering "they offered $X, take it?"; null when the text is not that answer. */
export async function handleOwnerDecision(ctx: ElfContext): Promise<ElfResult | null> {
  if (ctx.participant.role !== "owner") return null;
  const parentMessageIds = ctx.batch.messages.map((m) => m.parentMessageId).filter((x): x is string => !!x);
  const r = await ownerTurn({
    store: ctx.store,
    move: ctx.move,
    text: batchText(ctx.batch),
    parentMessageIds,
    clock: { now: ctx.now() },
  });
  if (!r) return null;
  return deliver(ctx, r, { partyId: null });
}

/** Which Elf answers a counterparty in this space: the one that owns their deal's mode. */
export async function counterpartyElf(ctx: Pick<ElfContext, "store">, spaceId: string) {
  const parties = await ctx.store.listDealPartiesBySpace(spaceId);
  const latest = [...parties].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const deal = latest ? await ctx.store.getDeal(latest.dealId) : undefined;
  return deal ? policyFor(deal.mode).elf : null;
}
