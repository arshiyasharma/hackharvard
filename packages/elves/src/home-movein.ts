import type { Move, MoveinTask, MoveinTaskKey, MoveinTaskStatus, Store } from "@elves/shared";
import { type ElfContext, type ElfResult, memoryPreamble, TEXT_STYLE } from "./contract.ts";
import { formatDate, parseDate, parseDateRange } from "./facts.ts";
import { extractHousingHeuristic } from "./home-facts.ts";
import { isSubletOutIntent } from "./home-sublet.ts";
import { bookedPickups } from "./relations.ts";

/**
 * Move-in week: once the Home Elf knows the move-in date and the new address it writes the checklist (utilities,
 * internet, renters insurance, the USPS address change, keys, the condition report, and somewhere for the bags
 * when move-out comes first), texts it with dates, and keeps it as the owner ticks things off. A sweep nudges the
 * owner once per task as it comes due. The Elf orders nothing itself: the owner places the orders.
 */

interface TaskSpec {
  key: MoveinTaskKey;
  label: string;
  /** "order", "set up": the verb in the checklist line. */
  verb: string;
  /** The short word the owner says back: "done with internet". */
  say: string;
  /** Days before move-in the task is due; 0 is move-in day. */
  daysBefore: number;
  /** Words the owner uses for it ("wifi" for internet). */
  words: RegExp;
}

export const MOVEIN_TASKS: TaskSpec[] = [
  {
    key: "electric",
    label: "Electric",
    verb: "set up",
    say: "electric",
    daysBefore: 10,
    words: /\b(electric(?:ity)?|power|eversource|national grid)\b/i,
  },
  { key: "gas", label: "Gas", verb: "set up", say: "gas", daysBefore: 10, words: /\bgas\b/i },
  {
    key: "internet",
    label: "Internet",
    verb: "order",
    say: "internet",
    daysBefore: 10,
    words: /\b(internet|wi-?fi|broadband|xfinity|comcast|fios|verizon|starry)\b/i,
  },
  {
    key: "renters_insurance",
    label: "Renters insurance",
    verb: "buy",
    say: "insurance",
    daysBefore: 7,
    words: /\b(renters?'? insurance|insurance|lemonade)\b/i,
  },
  {
    key: "address_change",
    label: "Address change",
    verb: "file with USPS",
    say: "address change",
    daysBefore: 7,
    words:
      /\b(address change|change of address|forward(?:ed|ing)? (?:my |the )?mail|mail forwarding|usps)\b/i,
  },
  { key: "keys", label: "Keys", verb: "pick up", say: "keys", daysBefore: 0, words: /\bkeys?\b|\bfob\b/i },
  {
    key: "condition_report",
    label: "Condition report",
    verb: "photograph every room and send it to the landlord",
    say: "condition report",
    daysBefore: 0,
    words: /\b(condition report|walk-?through|inspection|move-in photos|photos of the place)\b/i,
  },
  {
    key: "luggage_gap",
    label: "Bags for the gap",
    verb: "line up storage or a friend's closet",
    say: "bags",
    daysBefore: 0,
    words: /\b(luggage|bags?|suitcases?|boxes)\b/i,
  },
];

const SPEC_BY_KEY = new Map(MOVEIN_TASKS.map((t) => [t.key, t]));

const UTILITIES = /\butilit(?:y|ies)\b/i;
const MOVEIN_ASK =
  /\b(move[- ]?in(?: week| day| date|-ready)?|moving in|new (?:place|apartment|apt|address)|utilities|internet|wi-?fi|address change|change of address|renters?'? insurance|electric(?:ity)?|gas bill|condition report|checklist|what do i need (?:for|before) (?:the )?move)\b/i;
/** A hotel or Airbnb question is the hunt's; the checklist only mentions it. */
const HOTEL_ONLY = /\b(hotel|motel|airbnb)\b/i;
const OTHER_HOME_JOB = /\b(sublet|sublease|looking for a|find me|rent out|lease says|landlord)\b/i;

/** "set up internet at the new place", "what do I need for move-in": the owner wants the checklist. */
export function isMoveinIntent(text: string): boolean {
  return MOVEIN_ASK.test(text) && !OTHER_HOME_JOB.test(text);
}

const DONE =
  /^\s*(?:ok(?:ay)?[,. ]*)?(?:done with|finished|did|sorted|handled|got|ordered|booked|bought|completed|took care of|checked off|mark)\b|\b(?:is|are|'s)\s+(?:all\s+)?(?:done|set up|sorted|handled|ordered|booked|bound|taken care of|in place|live|on)\b|\bdone\b/i;
const SKIP =
  /\b(skip|no need for|don'?t need|do not need|not needed|forget|drop|already have|already had|not doing)\b/i;
const WHATS_LEFT =
  /\b(what'?s left|what is left|what remains|remaining|still open|show (?:me )?the (?:check)?list|the checklist|checklist|what do i (?:still )?(?:need|have) to do|where (?:am i|are we) on move-in|move-in status)\b/i;

export type MoveinFollowUp =
  | { kind: "done" | "skip"; keys: MoveinTaskKey[] }
  | { kind: "left" }
  | { kind: "address"; address: string };

/** The tasks a text names: "internet" → internet; "utilities" → electric and gas. */
export function taskKeysIn(text: string): MoveinTaskKey[] {
  const keys: MoveinTaskKey[] = [];
  if (UTILITIES.test(text)) keys.push("electric", "gas");
  for (const spec of MOVEIN_TASKS) if (spec.words.test(text) && !keys.includes(spec.key)) keys.push(spec.key);
  return keys;
}

const STREET =
  /\b(\d{1,6}[a-z]?\s+(?:[a-z0-9'.-]+\s+){0,4}?(?:st(?:reet)?|ave(?:nue)?|rd|road|blvd|boulevard|dr(?:ive)?|ln|lane|way|ct|court|pl(?:ace)?|ter(?:race)?|sq(?:uare)?|pkwy|parkway|hwy|cir(?:cle)?)\b\.?(?:,?\s*(?:apt|unit|#|suite|ste|floor|fl)\.?\s*[a-z0-9-]+)?(?:,\s*[a-z'.-]+(?:\s[a-z'.-]+){0,2}(?:,?\s*(?:ma|massachusetts|ny|ca|nj|ct|ri|nh)\b)?(?:\s*\d{5})?)?)/i;
const ADDRESS_LEAD = /\b(?:(?:new )?address(?: is|:)?|moving to|it'?s at|we'?re at|the place is at)\s+(.+)$/i;
const NOT_A_PLACE = /\b(mov(?:e|ing)|on|from|starting|lease|until|and then)\b/i;

/** "address is 12 Oak St Apt 2, Allston" or a bare street address. Null when the text has none. */
export function parseAddress(text: string, now: Date = new Date()): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  const street = clean.match(STREET);
  if (street?.[1]) {
    // "12 Oak St, moving in May 25": the tail after the comma is not a town.
    const parts = street[1].split(",").map((p) => p.trim());
    const kept = parts.filter((p, i) => i === 0 || !(NOT_A_PLACE.test(p) || parseDate(p, now)));
    return kept
      .join(", ")
      .replace(/[.\s]+$/, "")
      .replace(/\b[a-z]/g, (c) => c.toUpperCase())
      .replace(/\bMa\b/, "MA");
  }
  const lead = clean.match(ADDRESS_LEAD);
  if (lead?.[1] && /\d/.test(lead[1]) && lead[1].length <= 80) return lead[1].replace(/[.,\s]+$/, "");
  return null;
}

export function parseMoveinFollowUp(text: string, now: Date = new Date()): MoveinFollowUp | null {
  const t = text.trim();
  if (!t) return null;
  const keys = taskKeysIn(t);
  if (WHATS_LEFT.test(t) && !keys.length) return { kind: "left" };
  if (keys.length && SKIP.test(t)) return { kind: "skip", keys };
  if (keys.length && DONE.test(t)) return { kind: "done", keys };
  const explicit = t.match(/\b(?:new )?address(?: is|:)\s*(.+)$/i);
  if (explicit?.[1]) {
    const address = parseAddress(explicit[1], now) ?? explicit[1].trim().replace(/[.,\s]+$/, "");
    if (address) return { kind: "address", address };
  }
  return null;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

type ChecklistRow = Pick<MoveinTask, "moveId" | "key" | "label" | "dueAt">;

/** Due dates for a move: utilities and internet 10 days out, insurance and USPS 7, keys and the report on the day. */
export function checklistFor(move: Pick<Move, "id" | "moveInAt" | "moveOutAt">): ChecklistRow[] {
  const moveIn = move.moveInAt;
  if (!moveIn) return [];
  const gap = move.moveOutAt != null && move.moveOutAt < moveIn;
  return MOVEIN_TASKS.filter((t) => t.key !== "luggage_gap" || gap).map((t) => ({
    moveId: move.id,
    key: t.key,
    label: t.label,
    dueAt: t.key === "luggage_gap" ? (move.moveOutAt as string) : addDays(moveIn, -t.daysBefore),
  }));
}

/** One checklist line: "Internet: order by May 22", "Keys: pick up on Jun 1", "Gas: done". */
export function taskLine(task: MoveinTask, move: Pick<Move, "moveInAt" | "moveOutAt">): string {
  const spec = SPEC_BY_KEY.get(task.key);
  if (task.status === "done") return `${task.label}: done`;
  if (task.status === "skipped") return `${task.label}: skipped`;
  const when = `${task.dueAt === move.moveInAt ? "on" : "by"} ${formatDate(task.dueAt)}`;
  const label =
    task.key === "luggage_gap" && move.moveOutAt && move.moveInAt
      ? `${task.label} (${formatDate(move.moveOutAt)} to ${formatDate(move.moveInAt)})`
      : task.label;
  return `${label}: ${spec?.verb ?? "do"} ${when}`;
}

const HOTEL_HINT = 'Need a hotel for those nights? Say "find a hotel for the gap" and I\'ll look.';
const FOLLOWUP_HINT =
  'Say "done with internet", "skip insurance" or "what\'s left" as you go; I\'ll nudge you as each one comes due.';

/** Stuff → Home: the buyer pickups Stuff booked, as one checklist line, or "" when there are none. */
function pickupsLine(pickups: string[]): string {
  return pickups.length ? `🚚 Pickups booked (Stuff Elf): ${pickups.join(", ")}.` : "";
}

/** The whole checklist as the owner sees it, with Stuff's booked pickups when there are any. */
export function formatChecklist(tasks: MoveinTask[], move: Move, pickups: string[] = []): string {
  const head = `📋 Move-in checklist for ${move.toAddress ?? "the new place"} (move-in ${move.moveInAt ? formatDate(move.moveInAt) : "TBD"}):`;
  const gap = tasks.some((t) => t.key === "luggage_gap" && t.status === "open");
  const body = tasks.map((t) => `• ${taskLine(t, move)}`).join("\n");
  return [head, body, pickupsLine(pickups), gap ? HOTEL_HINT : "", `💬 ${FOLLOWUP_HINT}`]
    .filter(Boolean)
    .join("\n\n");
}

/** Only what is still open, for "what's left", plus Stuff's booked pickups. */
export function formatRemaining(tasks: MoveinTask[], move: Move, pickups: string[] = []): string {
  const open = tasks.filter((t) => t.status === "open");
  if (!open.length)
    return ["✅ Nothing left on the move-in list. You're set.", pickupsLine(pickups)]
      .filter(Boolean)
      .join("\n\n");
  return [
    `📋 Still open for ${move.toAddress ?? "the new place"}:`,
    open.map((t) => `• ${taskLine(t, move)}`).join("\n"),
    pickupsLine(pickups),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The cursor that remembers which move-in fact the Elf just asked for ("date" or "address"), so the answer routes back. */
export function moveinAskKey(moveId: string): string {
  return `movein:ask:${moveId}`;
}
type MoveinAsk = "date" | "address";

const ASK_SYSTEM = `You are the Home Elf of Elves, a moving crew the owner texts. You are building their move-in week checklist (utilities, internet, renters insurance, address change, keys, condition report).

${TEXT_STYLE}
- At most 3 short lines in all.
- If facts.captured is set, line 1 confirms it in the owner's words.
- The last line asks for exactly ONE thing, the one in facts.ask: date = what day they move in; address = the new address.
- Never promise to order or set anything up yourself.`;

async function draftAsk(ctx: ElfContext, ask: MoveinAsk, captured: string | null): Promise<string> {
  const question = ask === "date" ? "What day do you move in?" : "What's the new address?";
  const template = captured ? `${captured}\n${question}` : question;
  if (ctx.llm.name === "fake") return template;
  try {
    const reply = await ctx.llm.draft({
      system: ASK_SYSTEM,
      user: `${memoryPreamble(ctx.conversation)}\n\nFacts (JSON):\n${JSON.stringify({ ask, captured })}\n\nWrite the reply.`,
      maxTokens: 120,
    });
    return reply || template;
  } catch (err) {
    ctx.log.warn("movein ask draft failed; using template", { error: String(err) });
    return template;
  }
}

/** Create the checklist, or move its dates when the move-in date changed; statuses survive. */
async function syncChecklist(store: Store, move: Move): Promise<MoveinTask[]> {
  const existing = new Map((await store.listMoveinTasks(move.id)).map((t) => [t.key, t]));
  const wanted = checklistFor(move);
  for (const row of wanted) {
    const prev = existing.get(row.key);
    if (prev && prev.dueAt === row.dueAt) continue;
    // A moved date is a new deadline: the reminder fires again for it.
    await store.upsertMoveinTask(prev ? { ...row, remindedAt: null } : row);
  }
  // The gap closed (move-out now after move-in): the bags line is moot.
  const bags = existing.get("luggage_gap");
  if (bags && bags.status === "open" && !wanted.some((w) => w.key === "luggage_gap"))
    await store.upsertMoveinTask({ ...bags, status: "skipped" });
  return store.listMoveinTasks(move.id);
}

function labelsOf(keys: MoveinTaskKey[]): string {
  const names = keys.map((k) => SPEC_BY_KEY.get(k)?.label.toLowerCase() ?? k);
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The owner's side of move-in week. Null when the text is not about it, so the hunt and the canned skills get
 * their turn. Needs the move-in date and the new address, asked one at a time; the answers go onto the move.
 */
export async function handleMovein(ctx: ElfContext, text: string, parent: string): Promise<ElfResult | null> {
  const now = ctx.now();
  const tasks = await ctx.store.listMoveinTasks(ctx.move.id);
  const active = tasks.length > 0;
  const pending = ((await ctx.store.getCursor(moveinAskKey(ctx.move.id))) || null) as MoveinAsk | null;
  const intent = isMoveinIntent(text);
  const fu = active ? parseMoveinFollowUp(text, now) : null;
  if (!intent && !pending && !fu) return null;
  // A hotel ask is the hunt's, even in move-in week; so is a search or a sublet while an answer is pending.
  if (!fu && HOTEL_ONLY.test(text) && !taskKeysIn(text).length) return null;
  if (!fu && !intent && (extractHousingHeuristic(text, now).wantsSearchNow || isSubletOutIntent(text)))
    return null;

  const events: NonNullable<ElfResult["events"]> = [];
  const movePatch: NonNullable<ElfResult["movePatch"]> = {};
  const reply = (lines: string[], extra: Partial<ElfResult> = {}): ElfResult => ({
    replies: [{ text: lines.filter(Boolean).join("\n"), parentMessageId: parent }],
    events,
    movePatch,
    ...extra,
  });
  const board = (status: "working" | "waiting", lastUpdate: string): ElfResult["boardPatch"] => ({
    status,
    currentTask: "Move-in week checklist",
    lastUpdate,
  });

  // Follow-ups on a checklist that exists.
  if (fu && fu.kind !== "address") {
    const move = ctx.move;
    const pickups = await bookedPickups(ctx.store, move);
    if (fu.kind === "left")
      return reply([formatRemaining(tasks, move, pickups)], {
        boardPatch: board("working", "Listed what's left"),
      });
    const status: MoveinTaskStatus = fu.kind === "done" ? "done" : "skipped";
    const touched: MoveinTask[] = [];
    for (const key of fu.keys) {
      const t = tasks.find((x) => x.key === key);
      if (!t || t.status === status) continue;
      touched.push(await ctx.store.upsertMoveinTask({ ...t, status }));
    }
    const after = await ctx.store.listMoveinTasks(move.id);
    const open = after.filter((t) => t.status === "open");
    if (!touched.length) {
      const named = labelsOf(fu.keys);
      const was = `${named.charAt(0).toUpperCase()}${named.slice(1)} ${fu.keys.length > 1 ? "were" : "was"} already ${status === "done" ? "done" : "skipped"}${
        fu.keys.some((k) => !tasks.some((t) => t.key === k)) ? ", or not on the list" : ""
      }.`;
      return reply([was, formatRemaining(after, move, pickups)], { boardPatch: board("working", was) });
    }
    for (const t of touched)
      events.push({ type: `movein.task_${status}`, payload: { key: t.key, dueAt: t.dueAt } });
    const names = labelsOf(touched.map((t) => t.key));
    const head =
      status === "done" ? `Nice, ${names} ${touched.length > 1 ? "are" : "is"} done.` : `Skipping ${names}.`;
    const tail = open.length
      ? [`${open.length} left:`, ...open.map((t) => taskLine(t, move))]
      : ["That's the whole list. You're set for move-in."];
    return reply([head, ...tail], {
      boardPatch: board(
        open.length ? "working" : "waiting",
        open.length
          ? `Move-in: ${open.length} task${open.length === 1 ? "" : "s"} left`
          : "Move-in checklist complete",
      ),
    });
  }

  // Facts from this turn: the move-in date and the new address.
  let move: Move = { ...ctx.move };
  const captured: string[] = [];
  const saysMoveIn = /\bmove[- ]?in\b|\bmoving in\b|\bget the keys\b|\blease starts\b/i.test(text);
  if (pending !== "address" && (!move.moveInAt || saysMoveIn || pending === "date")) {
    const date = parseDateRange(text, now).start ?? parseDate(text, now);
    if (date && date !== move.moveInAt) {
      move = { ...move, moveInAt: date };
      movePatch.moveInAt = date;
      captured.push(`move-in ${formatDate(date)}`);
    }
  }
  const address =
    fu?.kind === "address"
      ? fu.address
      : pending === "address" || !move.toAddress || /\baddress\b/i.test(text)
        ? parseAddress(text, now)
        : null;
  if (address && address !== move.toAddress) {
    move = { ...move, toAddress: address };
    movePatch.toAddress = address;
    captured.push(address);
  }
  // An answer we were waiting for that answers nothing: let go rather than nag.
  if (pending && !intent && !captured.length) {
    await ctx.store.setCursor(moveinAskKey(move.id), "");
    return reply(
      [
        `No rush. When you know the ${pending === "date" ? "move-in date" : "new address"}, text it to me and I'll write up the move-in checklist.`,
      ],
      {
        boardPatch: board(
          "waiting",
          `Move-in: waiting on the ${pending === "date" ? "move-in date" : "new address"}`,
        ),
      },
    );
  }
  const capturedLine = captured.length ? `Got it: ${captured.join(", ")}.` : null;

  if (!move.moveInAt || !move.toAddress) {
    const ask: MoveinAsk = !move.moveInAt ? "date" : "address";
    await ctx.store.setCursor(moveinAskKey(move.id), ask);
    const body = await draftAsk(ctx, ask, capturedLine);
    return reply([body], {
      boardPatch: board("waiting", `Move-in: need the ${ask === "date" ? "move-in date" : "new address"}`),
    });
  }

  await ctx.store.setCursor(moveinAskKey(move.id), "");
  const list = await syncChecklist(ctx.store, move);
  events.push({
    type: active ? "movein.checklist_updated" : "movein.checklist_created",
    payload: { moveInAt: move.moveInAt, toAddress: move.toAddress, tasks: list.map((t) => t.key) },
  });
  const open = list.filter((t) => t.status === "open").length;
  return reply([capturedLine ?? "", formatChecklist(list, move, await bookedPickups(ctx.store, move))], {
    boardPatch: board(
      "working",
      `Move-in ${formatDate(move.moveInAt)}: ${open} of ${list.length} tasks open`,
    ),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Reminders

export interface MoveinReminder {
  moveId: string;
  key: MoveinTaskKey;
  dueAt: string;
  text: string;
}

/** How far ahead the sweep nudges: a task due within this many days gets its one text. */
export const MOVEIN_REMIND_DAYS = 2;

function daysUntil(iso: string, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - today) / 86_400_000);
}

/** The one reminder for a task, phrased by how close it is. */
export function reminderText(
  task: MoveinTask,
  move: Pick<Move, "moveInAt" | "moveOutAt" | "toAddress">,
  now: Date,
): string {
  const spec = SPEC_BY_KEY.get(task.key);
  const days = daysUntil(task.dueAt, now);
  const when =
    days < 0
      ? `was due ${formatDate(task.dueAt)}`
      : days === 0
        ? "is due today"
        : days === 1
          ? "is due tomorrow"
          : `is due ${formatDate(task.dueAt)}`;
  const label =
    task.key === "luggage_gap" && move.moveOutAt && move.moveInAt
      ? `${task.label} (${formatDate(move.moveOutAt)} to ${formatDate(move.moveInAt)})`
      : task.label;
  const todo = spec ? ` (${spec.verb}${task.dueAt === move.moveInAt ? "" : " before move-in"})` : "";
  const say = spec?.say ?? task.label.toLowerCase();
  return `Move-in reminder: ${label} ${when}${todo}. Say "done with ${say}" when it's sorted, or "skip ${say}".`;
}

/**
 * Every open task due within MOVEIN_REMIND_DAYS that has not been nudged yet, marked reminded. Runs with Last
 * Call on the same timer; the service texts each one to the owner's space.
 */
export async function moveinSweep(
  store: Store,
  clock: { now: Date },
): Promise<{ reminders: MoveinReminder[] }> {
  const through = new Date(clock.now.getTime() + MOVEIN_REMIND_DAYS * 86_400_000).toISOString().slice(0, 10);
  const reminders: MoveinReminder[] = [];
  const moves = new Map<string, Move | undefined>();
  for (const task of await store.listDueMoveinTasks(through)) {
    if (!moves.has(task.moveId)) moves.set(task.moveId, await store.getMove(task.moveId));
    const move = moves.get(task.moveId);
    if (!move) continue;
    await store.upsertMoveinTask({ ...task, remindedAt: clock.now.toISOString() });
    reminders.push({
      moveId: move.id,
      key: task.key,
      dueAt: task.dueAt,
      text: reminderText(task, move, clock.now),
    });
  }
  return { reminders };
}
