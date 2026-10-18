import {
  Brief,
  type BriefItem,
  BriefItemCategory,
  BriefItemIntent,
  ELF_LABELS,
  type ElfName,
  emptyBrief,
  type OnboardingState,
  onboardingKey,
  parseOnboardingState,
} from "@elves/shared";
import { z } from "zod";
import { batchText, type ElfContext, type ElfResult, lastMessageId, memoryPreamble } from "./contract.ts";
import { DEFAULT_WEIGHT_LB, formatDate } from "./facts.ts";
import { crewIntro, crewScopePrompt, STATUS_HINT } from "./crew.ts";
import { describeItem, identifyFromPhotos } from "./intake.ts";

/**
 * The onboarding call. From the owner's first text until they confirm the brief, the Crew Lead only gathers:
 * no planning, no listing, no searching. The very first text opens with the crew's ability list (`crewIntro`),
 * and anything off that list gets a plain "the crew can't do that". Each turn one Sonnet call reads the conversation and
 * returns the updated brief plus the next text. When the owner says yes to the played-back brief, the
 * specialists are dispatched from it (`dispatchBrief`) and the Crew Lead goes back to its usual turn.
 */

/** Asking turns before the Crew Lead must play the brief back whatever is still unknown. */
export const MAX_ASK_TURNS = 4;

const CONTRACT = `You are the Crew Lead of Elves, a moving crew the owner texts. This is the onboarding call: the owner has just reached out about a move. Your only job on this call is to understand the move and write it down as a brief that the crew will work from. You do not plan, book, list, search, price, research or promise anything, and you do not say what will happen next. The crew starts only after the owner confirms the brief.

${crewScopePrompt()}

Scope on this call:
- If the owner asks what the crew can do, give the list above in short plain lines, then go back to gathering.
- If the owner asks for something the crew does not do (a truck, movers, reading their lease, paying someone), say plainly in one line that the crew can't do that, record the ask in asksVerbatim anyway, and keep gathering. Never offer it, and never name an outside company.
- Otherwise do not describe what the crew or any Elf will do; that comes after the owner confirms.

The brief (the JSON you return):
- move: move-out date and how firm it is, move-in date, where from, where to (or that they still need a place), distance, why they are moving.
- people: who is moving, roommates by name, who can help lift or drive, when the owner is available.
- stuff: every item they mention with intent (sell, donate, keep, buy, undecided) and notes in their words; rough volume; anything big or awkward; how they feel about selling vs donating vs dumping.
- home: the lease situation and notes; whether they need a place found and what they want; the gap between leases; move-in needs (internet, utilities, address change).
- money: budget for the move, how they pay or want to be paid, who splits what, what they optimize for.
- moveDay: truck, movers, car or friends; storage; stairs, elevator, parking, building rules; timing constraints.
- worries, priorities and asksVerbatim in the owner's own words. openQuestions: what you still do not know, most important first.

Essentials, in order: move-out date; where from; where to, or that they need a place; what goes with them and what has to go; how it moves; whether anyone else is involved; the lease situation. Everything else is nice to have.

Rules for the brief:
- Record only what the owner said or clearly implied. Never invent. Null means unknown.
- Resolve relative dates to ISO dates using today's date in the facts.
- Carry the previous brief forward in full; change only what this turn adds or corrects.
- Keep the owner's phrasing in notes, worries, priorities and asksVerbatim.

Rules for the reply (a text message):
- Plain text. No markdown, no bullet symbols, no numbered lists, no headers. At most one emoji, usually none.
- Sound like a sharp, warm coordinator who listens, not a form. Short lines, one thought each.
- Never ask for anything already in the brief, the working memory or the conversation.
- Never describe what the crew will do, offer options, give advice or estimate prices.
- phase "ask": the reply gathers more. phase "confirm": the reply plays the brief back for the owner to confirm.

The confirm reply: one opening line like "Here's what I've got:", then the brief as short plain lines in the owner's words (dates and how firm, from and to, what goes and what has to go, how it moves and who helps, lease, money, what they're worried about), then one line "Still TBD: ..." for the open questions instead of asking them again, then exactly "Reply yes to lock it in, or tell me what to change." Under 14 lines total.

When to confirm: as soon as every essential is known and only nice-to-haves remain, or when turnsLeft in the facts is 0. Never spend a turn on nice-to-haves alone. When the owner is correcting the played-back brief, apply the change and confirm again without new questions. On the first contact (firstContact true) the crew intro with the full ability list is sent right above your reply, so never introduce yourself or list abilities in that reply; if the owner's text is only a greeting with no facts, just ask what the move is.`;

export const ONBOARDING_PROMPTS = {
  /** Baseline: the crew's old habit, one question per text. */
  one_at_a_time: `${CONTRACT}

Questioning strategy: ask exactly ONE question per reply, the most important open essential first. Reply in two or three lines: one line confirming what you just captured in the owner's words, one question. Keep going one question at a time until the essentials are covered, then confirm.`,

  /** Grouped sweeps: one bundle of the top gaps per text, nuance invited in the tail. */
  sweep: `${CONTRACT}

Questioning strategy: the owner should have to send as few texts as possible. On your first asking turn, acknowledge in one line what they told you, then ask ONE bundle of the three or four most important open essentials as one or two natural sentences (not a list), grouped so they can answer in a single text: dates and where to, then what's going with them versus what has to go, then how they're moving it and who's around to help. End the bundle with one open tail that invites nuance without a specific question, like "and anything you're worried about or I should know going in?". On your second asking turn, sweep whatever essentials are still open the same way, in one message. Then confirm. Aim for two asking turns; three at most. Three to five short lines per reply.`,

  /** Mirror and fill: play the move back with the gaps as blanks, state assumptions instead of asking. */
  mirror: `${CONTRACT}

Questioning strategy: play back and fill in. Each asking reply mirrors the move as a compact running picture in the owner's words with the gaps left as blanks inside it, so answering means filling blanks rather than reading questions. Shape: "So: out of the Allston place Nov 1, hard date? Into somewhere in Somerville you haven't found yet. Couch and desk go, bed stays? And who's moving with you, and is it a truck or friends with cars?" State sensible assumptions out loud instead of asking about them ("I'll assume Venmo is fine and you're around weekday evenings unless you say otherwise"), so the owner only corrects what's wrong. Prefer one rich reply over several thin ones: cover every open essential in your first reply, catch the stragglers in a second, then confirm. Three to six short lines per reply.`,
} as const;
export type OnboardingPromptId = keyof typeof ONBOARDING_PROMPTS;
export const DEFAULT_ONBOARDING_PROMPT: OnboardingPromptId = "sweep";

export function onboardingPromptId(env: NodeJS.ProcessEnv = process.env): OnboardingPromptId {
  const id = env.ELVES_ONBOARDING_PROMPT;
  return id && id in ONBOARDING_PROMPTS ? (id as OnboardingPromptId) : DEFAULT_ONBOARDING_PROMPT;
}

/**
 * The brief as the model writes it. The API caps nullable fields per schema at 16 and the Brief has two dozen,
 * so on the wire an unknown string is "" and an unknown number is -1; `briefFromWire` turns those back into nulls.
 */
const str = (d: string) => z.string().describe(`${d}; empty string when unknown`);
const num = (d: string) => z.number().describe(`${d}; -1 when unknown`);
export const BriefWire = z.object({
  move: z.object({
    moveOutDate: str("ISO date YYYY-MM-DD the owner moves out"),
    moveOutFlexibility: str("how firm the move-out date is"),
    moveInDate: str("ISO date YYYY-MM-DD the owner moves in"),
    fromAddress: str("current address or at least neighborhood and city"),
    toAddress: str("destination address, neighborhood, city, or 'not found yet'"),
    distance: Brief.shape.move.shape.distance,
    reason: str("why they are moving"),
  }),
  people: z.object({
    household: str("who is moving"),
    roommates: z.array(z.string()),
    helpers: str("who can lift, drive or cover a pickup, and when"),
    availability: str("when the owner can be around for pickups and viewings"),
  }),
  stuff: z.object({
    items: z.array(
      z.object({
        name: z.string(),
        category: BriefItemCategory,
        intent: BriefItemIntent,
        notes: str("condition, what they paid, a price they hope for, sentimental"),
      }),
    ),
    volume: str("rough amount of stuff"),
    bigOrAwkward: z.array(z.string()),
    attitude: str("how they feel about selling vs donating vs dumping"),
  }),
  home: z.object({
    leaseSituation: Brief.shape.home.shape.leaseSituation,
    leaseNotes: str("landlord, notice, deposit, whether subletting is allowed, in their words"),
    needsPlace: z.enum(["yes", "no", "unknown"]).describe("whether the crew should find them housing"),
    housing: z.object({
      kind: z.enum(["room", "sublet", "apartment", "hotel", "unknown"]),
      areas: z.array(z.string()),
      budgetMonthlyUsd: num("most they would pay per month"),
      from: str("ISO date they need the place from"),
      until: str("ISO date they need it until"),
      mustHaves: z.array(z.string()),
    }),
    gap: str("nights between leases and what happens then"),
    moveInNeeds: z.array(z.string()),
  }),
  money: z.object({
    budgetUsd: num("what they can spend on the whole move"),
    paymentPrefs: z.array(z.string()),
    splits: str("who shares which costs or proceeds"),
    priority: Brief.shape.money.shape.priority,
  }),
  moveDay: z.object({
    transport: Brief.shape.moveDay.shape.transport,
    storage: str("storage needed, for what and how long"),
    access: str("stairs, elevator, loading dock, parking, building rules"),
    timing: str("time-of-day constraints on move day"),
  }),
  worries: z.array(z.string()),
  priorities: z.array(z.string()),
  asksVerbatim: z.array(z.string()),
  openQuestions: z.array(z.string()),
});
export type BriefWire = z.infer<typeof BriefWire>;

const s2n = (v: string): string | null => (/^\s*(|unknown|null|n\/a|none)\s*$/i.test(v) ? null : v.trim());
const n2n = (v: number): number | null => (v < 0 ? null : v);
const n2s = (v: string | null): string => v ?? "";
const n2num = (v: number | null): number => v ?? -1;

export function briefFromWire(w: BriefWire): Brief {
  const needsPlace = w.home.needsPlace === "yes" ? true : w.home.needsPlace === "no" ? false : null;
  const h = w.home.housing;
  const housingKnown =
    h.kind !== "unknown" ||
    h.areas.length > 0 ||
    h.budgetMonthlyUsd >= 0 ||
    h.from !== "" ||
    h.mustHaves.length > 0;
  return {
    move: {
      moveOutDate: s2n(w.move.moveOutDate),
      moveOutFlexibility: s2n(w.move.moveOutFlexibility),
      moveInDate: s2n(w.move.moveInDate),
      fromAddress: s2n(w.move.fromAddress),
      toAddress: s2n(w.move.toAddress),
      distance: w.move.distance,
      reason: s2n(w.move.reason),
    },
    people: {
      household: s2n(w.people.household),
      roommates: w.people.roommates,
      helpers: s2n(w.people.helpers),
      availability: s2n(w.people.availability),
    },
    stuff: {
      items: w.stuff.items.map((i) => ({ ...i, notes: s2n(i.notes) })),
      volume: s2n(w.stuff.volume),
      bigOrAwkward: w.stuff.bigOrAwkward,
      attitude: s2n(w.stuff.attitude),
    },
    home: {
      leaseSituation: w.home.leaseSituation,
      leaseNotes: s2n(w.home.leaseNotes),
      needsPlace,
      housing:
        needsPlace || housingKnown
          ? {
              kind: h.kind,
              areas: h.areas,
              budgetMonthlyUsd: n2n(h.budgetMonthlyUsd),
              from: s2n(h.from),
              until: s2n(h.until),
              mustHaves: h.mustHaves,
            }
          : null,
      gap: s2n(w.home.gap),
      moveInNeeds: w.home.moveInNeeds,
    },
    money: {
      budgetUsd: n2n(w.money.budgetUsd),
      paymentPrefs: w.money.paymentPrefs,
      splits: s2n(w.money.splits),
      priority: w.money.priority,
    },
    moveDay: {
      transport: w.moveDay.transport,
      storage: s2n(w.moveDay.storage),
      access: s2n(w.moveDay.access),
      timing: s2n(w.moveDay.timing),
    },
    worries: w.worries,
    priorities: w.priorities,
    asksVerbatim: w.asksVerbatim,
    openQuestions: w.openQuestions,
  };
}

export function briefToWire(b: Brief): BriefWire {
  const h = b.home.housing;
  return {
    move: {
      moveOutDate: n2s(b.move.moveOutDate),
      moveOutFlexibility: n2s(b.move.moveOutFlexibility),
      moveInDate: n2s(b.move.moveInDate),
      fromAddress: n2s(b.move.fromAddress),
      toAddress: n2s(b.move.toAddress),
      distance: b.move.distance,
      reason: n2s(b.move.reason),
    },
    people: {
      household: n2s(b.people.household),
      roommates: b.people.roommates,
      helpers: n2s(b.people.helpers),
      availability: n2s(b.people.availability),
    },
    stuff: {
      items: b.stuff.items.map((i) => ({ ...i, notes: n2s(i.notes) })),
      volume: n2s(b.stuff.volume),
      bigOrAwkward: b.stuff.bigOrAwkward,
      attitude: n2s(b.stuff.attitude),
    },
    home: {
      leaseSituation: b.home.leaseSituation,
      leaseNotes: n2s(b.home.leaseNotes),
      needsPlace: b.home.needsPlace == null ? "unknown" : b.home.needsPlace ? "yes" : "no",
      housing: {
        kind: h?.kind ?? "unknown",
        areas: h?.areas ?? [],
        budgetMonthlyUsd: n2num(h?.budgetMonthlyUsd ?? null),
        from: n2s(h?.from ?? null),
        until: n2s(h?.until ?? null),
        mustHaves: h?.mustHaves ?? [],
      },
      gap: n2s(b.home.gap),
      moveInNeeds: b.home.moveInNeeds,
    },
    money: {
      budgetUsd: n2num(b.money.budgetUsd),
      paymentPrefs: b.money.paymentPrefs,
      splits: n2s(b.money.splits),
      priority: b.money.priority,
    },
    moveDay: {
      transport: b.moveDay.transport,
      storage: n2s(b.moveDay.storage),
      access: n2s(b.moveDay.access),
      timing: n2s(b.moveDay.timing),
    },
    worries: b.worries,
    priorities: b.priorities,
    asksVerbatim: b.asksVerbatim,
    openQuestions: b.openQuestions,
  };
}

export const OnboardingTurn = z.object({
  brief: BriefWire,
  phase: z.enum(["ask", "confirm"]),
  asking: z
    .array(z.string())
    .describe("brief fields this reply asks about, e.g. 'move.moveOutDate'; empty on confirm"),
  reply: z.string().describe("the text message to the owner"),
});
export type OnboardingTurn = z.infer<typeof OnboardingTurn>;

const YES =
  /^\s*(yes|yep|yeah|yup|yas|sure|ok|okay|correct|looks good|looks right|all good|that's right|thats right|perfect|lock it in|lock it|confirmed|confirm|go ahead|do it|👍|✅)[\s!.]*$/i;

/** A bare yes to the played-back brief. "yes but move the date" is a correction, not a confirmation. */
export function isBriefConfirmation(text: string): boolean {
  return YES.test(text.trim());
}

export async function loadOnboarding(ctx: ElfContext): Promise<OnboardingState | null> {
  return parseOnboardingState(await ctx.store.getCursor(onboardingKey(ctx.move.id)));
}

async function saveOnboarding(ctx: ElfContext, state: OnboardingState) {
  await ctx.store.setCursor(onboardingKey(ctx.move.id), JSON.stringify(state));
}

/**
 * The onboarding turn, or null when this move is past onboarding (or the fake model is in use, which keeps the
 * deterministic template path for tests). Only the owner is onboarded; a move that existed before onboarding
 * shipped has no state and is left alone.
 */
export async function handleOnboarding(ctx: ElfContext): Promise<ElfResult | null> {
  if (ctx.llm.name === "fake" || ctx.participant.role !== "owner") return null;
  let state = await loadOnboarding(ctx);
  if (!state) {
    if (!ctx.firstContact) return null;
    state = {
      status: "gathering",
      brief: emptyBrief(),
      askTurns: 0,
      prompt: onboardingPromptId(),
      startedAt: ctx.now().toISOString(),
      confirmedAt: null,
    };
  }
  if (state.status === "confirmed") return null;

  const text = batchText(ctx.batch);
  const parent = lastMessageId(ctx.batch);
  if (state.status === "confirming" && isBriefConfirmation(text)) return dispatchBrief(ctx, state, parent);

  // Photos during the call are captured into the brief, not priced or listed.
  const intake = await identifyFromPhotos(ctx);
  for (const it of intake.items) {
    if (state.brief.stuff.items.some((b) => b.name.toLowerCase() === it.name.toLowerCase())) continue;
    state.brief.stuff.items.push({
      name: it.name,
      category: it.category as BriefItem["category"],
      intent: "undecided",
      notes: `from a photo: ${describeItem(it)}`,
    });
  }
  if (ctx.signal.aborted) return { replies: [] };

  const now = ctx.now();
  const turnsLeft = Math.max(0, MAX_ASK_TURNS - state.askTurns);
  const facts = {
    today: now.toISOString().slice(0, 10),
    firstContact: ctx.firstContact,
    status: state.status,
    turnsLeft,
    identifiedFromPhotos: intake.items.map(describeItem),
    photosUnreadable: intake.failed,
    brief: briefToWire(state.brief),
  };
  let turn: OnboardingTurn;
  try {
    turn = await ctx.llm.extract(OnboardingTurn, {
      model: "smart",
      system:
        ONBOARDING_PROMPTS[state.prompt as OnboardingPromptId] ??
        ONBOARDING_PROMPTS[DEFAULT_ONBOARDING_PROMPT],
      user: `${memoryPreamble(ctx.conversation)}\n\nFacts for this turn (JSON):\n${JSON.stringify(facts)}\n\nOwner's latest message(s):\n"""${text}"""\n\nReturn the updated brief, the phase, and the reply.`,
    });
  } catch (err) {
    ctx.log.warn("onboarding turn failed; falling back to the usual Crew Lead turn", { error: String(err) });
    return null;
  }
  if (ctx.signal.aborted) return { replies: [] };

  const confirm = turn.phase === "confirm" || turnsLeft === 0;
  state.brief = briefFromWire(turn.brief);
  state.status = confirm ? "confirming" : "gathering";
  if (!confirm) state.askTurns += 1;
  await saveOnboarding(ctx, state);

  const reply = ctx.firstContact ? `${crewIntro()}\n\n${turn.reply.trim()}` : turn.reply.trim();
  return {
    replies: [{ text: reply, parentMessageId: parent }],
    events: [
      {
        type: "brief.updated",
        payload: {
          phase: confirm ? "confirm" : "ask",
          asking: turn.asking,
          prompt: state.prompt,
          brief: turn.brief,
        },
      },
    ],
    boardPatch: {
      status: "working",
      currentTask: confirm
        ? "Onboarding: waiting for the owner to confirm the brief"
        : "Onboarding: gathering the brief",
      lastUpdate: confirm
        ? "Brief played back to the owner"
        : turn.asking.length
          ? `Asked about ${turn.asking.join(", ")}`
          : "Listening",
    },
  };
}

export interface Dispatch {
  elf: ElfName;
  task: string;
  status: "working" | "waiting";
}

/** Which Elf starts on what, read off the confirmed brief. Deterministic, so it is the same in tests and live. */
export function dispatchesFor(brief: Brief): Dispatch[] {
  const out: Dispatch[] = [];
  const sell = brief.stuff.items.filter((i) => i.intent === "sell").map((i) => i.name);
  const donate = brief.stuff.items.filter((i) => i.intent === "donate").map((i) => i.name);
  const buy = brief.stuff.items.filter((i) => i.intent === "buy").map((i) => i.name);
  const undecided = brief.stuff.items.filter((i) => i.intent === "undecided").map((i) => i.name);
  const stuff: string[] = [];
  if (sell.length) stuff.push(`sell ${sell.join(", ")}`);
  if (donate.length) stuff.push(`donate ${donate.join(", ")}`);
  if (buy.length) stuff.push(`find ${buy.join(", ")}`);
  if (undecided.length) stuff.push(`decide on ${undecided.join(", ")}`);
  if (stuff.length) out.push({ elf: "stuff", task: stuff.join("; "), status: "working" });

  const home: string[] = [];
  if (brief.home.needsPlace && brief.home.housing) {
    const h = brief.home.housing;
    home.push(
      `find a ${h.kind === "unknown" ? "place" : h.kind}${h.areas.length ? ` in ${h.areas.join(" or ")}` : ""}${h.budgetMonthlyUsd != null ? ` under $${h.budgetMonthlyUsd}/mo` : ""}`,
    );
  } else if (brief.home.needsPlace) home.push("find a place");
  if (brief.home.leaseSituation === "subletting_out") home.push("sublet the current place");
  // Storage is a SpareFoot search, so it is Home's; trucks and movers are not the crew's.
  if (brief.moveDay.storage) home.push(`find storage: ${brief.moveDay.storage}`);
  else if (brief.home.gap && /stor/i.test(brief.home.gap)) home.push("find storage for the gap");
  if (brief.home.moveInNeeds.length) home.push(`move checklist: ${brief.home.moveInNeeds.join(", ")}`);
  if (home.length) out.push({ elf: "home", task: home.join("; "), status: "working" });

  const money: string[] = [];
  if (sell.length) money.push("escrow on each sale");
  if (brief.money.splits) money.push(brief.money.splits);
  if (brief.money.budgetUsd != null) money.push(`keep the move under $${brief.money.budgetUsd}`);
  if (money.length) out.push({ elf: "money", task: money.join("; "), status: "waiting" });
  return out;
}

const ITEM_INTENTS = new Set(["sell", "donate", "buy", "undecided"]);

/**
 * The owner said yes: write the brief's facts onto the move, create the items, put every Elf with work on the
 * board, and tell the owner who starts on what. The brief itself lives in the onboarding cursor and in the
 * `brief.confirmed` event, and working memory renders it for every Elf from here on.
 */
export async function dispatchBrief(
  ctx: ElfContext,
  state: OnboardingState,
  parent: string,
): Promise<ElfResult> {
  const brief = state.brief;
  const movePatch: NonNullable<ElfResult["movePatch"]> = {};
  const events: NonNullable<ElfResult["events"]> = [];
  if (brief.move.moveOutDate && brief.move.moveOutDate !== ctx.move.moveOutAt) {
    movePatch.moveOutAt = brief.move.moveOutDate;
    events.push({ type: "move.date_captured", payload: { kind: "move_out", date: brief.move.moveOutDate } });
  }
  if (brief.move.moveInDate && brief.move.moveInDate !== ctx.move.moveInAt) {
    movePatch.moveInAt = brief.move.moveInDate;
    events.push({ type: "move.date_captured", payload: { kind: "move_in", date: brief.move.moveInDate } });
  }
  if (brief.move.fromAddress && !ctx.move.fromAddress) movePatch.fromAddress = brief.move.fromAddress;
  if (
    brief.move.toAddress &&
    !ctx.move.toAddress &&
    !/not found|tbd|unknown|haven't/i.test(brief.move.toAddress)
  )
    movePatch.toAddress = brief.move.toAddress;

  const existing = await ctx.store.listItems(ctx.move.id);
  for (const it of brief.stuff.items) {
    if (!ITEM_INTENTS.has(it.intent)) continue;
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
    events.push({
      type: "item.captured",
      payload: { name: it.name, category: it.category, intent: it.intent },
    });
  }

  const dispatches = dispatchesFor(brief);
  for (const d of dispatches) {
    await ctx.store.patchBoard(ctx.move.id, d.elf, {
      status: d.status,
      currentTask: d.task,
      lastUpdate: "From the confirmed brief",
    });
    events.push({ type: "elf.dispatched", payload: { to: d.elf, task: d.task } });
  }
  events.push({
    type: "brief.confirmed",
    payload: { brief, prompt: state.prompt, askTurns: state.askTurns },
  });

  state.status = "confirmed";
  state.confirmedAt = ctx.now().toISOString();
  await saveOnboarding(ctx, state);

  const lines = ["Locked in. Here's who's on what:"];
  for (const d of dispatches) lines.push(`${ELF_LABELS[d.elf]}: ${d.task}.`);
  if (!dispatches.length)
    lines.push("Nothing for the crew to start on yet; text me when something comes up.");
  const moveOut = movePatch.moveOutAt ?? ctx.move.moveOutAt;
  lines.push(
    dispatches.some((d) => d.elf === "stuff")
      ? "Photos of anything you're selling, and the lowest you'd take, whenever you're ready."
      : "Text me anything that changes.",
    STATUS_HINT,
  );
  const replies: ElfResult["replies"] = [{ text: lines.join("\n"), parentMessageId: parent }];
  if (ctx.publicUrl && !ctx.move.boardLinkSent) {
    replies.push({ text: `Crew Board (live): ${ctx.publicUrl}/b/${ctx.move.id}`, parentMessageId: null });
    movePatch.boardLinkSent = true;
  }
  return {
    replies,
    movePatch,
    events,
    boardPatch: {
      status: "working",
      currentTask: moveOut ? `Move-out ${formatDate(moveOut)}` : "Brief confirmed; move-out date still open",
      lastUpdate: dispatches.length
        ? `Brief confirmed; dispatched ${dispatches.map((d) => ELF_LABELS[d.elf]).join(", ")}`
        : "Brief confirmed",
    },
  };
}
