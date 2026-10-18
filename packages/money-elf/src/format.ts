/**
 * How every Money Elf text is laid out, so it reads the same whether it answers the owner, asks them to approve
 * something, or goes out to a roommate or a buyer. The crew service puts "💸 Money Elf" on the first line of
 * every text it sends, so the body never names the Elf.
 *
 *   - blocks separated by a blank line: what happened, then the detail, then the one question on its own;
 *   - at most ONE emoji in the body, at the start of a line, from a fixed set:
 *       ✅ something moved or was recorded   ❓ the question waiting for a yes   🚫 refused or blocked
 *       📋 the Ledger itself
 *   - a dashboard link, when there is one, closes the text as its own block.
 *
 * Both functions are idempotent, so a text that was already laid out (or already carries an emoji) is left alone.
 */

const EMOJI_START = /^\p{Extended_Pictographic}/u;

/** A line that asks the owner for something: it ends in a question or tells them how to answer. */
const ASKS = /(?:\?\s*$|\bReply\b|\bSay\b|\bTap\b|\bText ["“]|\bOK it\b)/;

const DONE_EVENTS = new Set([
  "approval.granted",
  "ledger.entry_added",
  "payment.requested",
  "payment.received",
  "payment.sent",
  "deposit.recorded",
  "deposit.returned",
  "escrow.opened",
  "escrow.released",
  "escrow.refunded",
  "loan.created",
  "contact.saved",
]);
const REFUSED_EVENTS = new Set(["scam.flagged", "money.sensitive_blocked"]);

export type Tone = "ask" | "done" | "refused" | "ledger" | "plain";

/** What a reply is, from the lines it says and the events its turn produced. */
export function toneOf(lines: string[], events: { type: string }[] = []): Tone {
  if (lines.some((l) => ASKS.test(l) && /\bReply\b|\?\s*$/.test(l))) return "ask";
  if (events.some((e) => REFUSED_EVENTS.has(e.type))) return "refused";
  if (events.some((e) => e.type === "ledger.shown")) return "ledger";
  if (events.some((e) => DONE_EVENTS.has(e.type))) return "done";
  return "plain";
}

function lastIndexWhere<T>(xs: T[], f: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i] as T)) return i;
  return -1;
}

const MARK: Record<Exclude<Tone, "plain">, string> = { ask: "❓", done: "✅", refused: "🚫", ledger: "📋" };

function mark(tone: Tone, line: string): string {
  if (tone === "plain" || EMOJI_START.test(line)) return line;
  return `${MARK[tone]} ${line}`;
}

/** Lines of one reply as blocks: the headline, the detail together, the question alone; at most one emoji. */
export function formatLines(
  rawLines: string[],
  opts: { events?: { type: string }[]; link?: string | null } = {},
): string {
  const lines = rawLines.map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";
  if (lines.some((l) => EMOJI_START.test(l)) || lines.some((l) => l.includes("\n\n")))
    return [...lines, ...(opts.link ? [`Dashboard: ${opts.link}`] : [])].join("\n\n");
  const tone = toneOf(lines, opts.events);
  const askIdx = lastIndexWhere(lines, (l) => ASKS.test(l));
  const blocks: string[] = [];
  if (tone === "ask" && askIdx > 0) {
    const head = lines[0] as string;
    const detail = lines.slice(1, askIdx);
    blocks.push(head, ...(detail.length ? [detail.join("\n")] : []), mark("ask", lines[askIdx] as string));
    for (const rest of lines.slice(askIdx + 1)) blocks.push(rest);
  } else if (tone === "ask") {
    // The question is the first line: it keeps its emoji, anything after it is detail.
    blocks.push(mark("ask", lines[0] as string));
    if (lines.length > 1) blocks.push(lines.slice(1).join("\n"));
  } else {
    blocks.push(mark(tone, lines[0] as string));
    if (lines.length > 1) blocks.push(lines.slice(1).join("\n"));
  }
  if (opts.link) blocks.push(`Dashboard: ${opts.link}`);
  return blocks.join("\n\n");
}

/** One outgoing text (to a roommate, a buyer, or the owner) laid out the same way, from its sentences. */
export function formatOutbound(text: string, opts: { link?: string | null } = {}): string {
  const t = text.trim();
  if (!t) return t;
  if (t.includes("\n\n") || EMOJI_START.test(t)) return opts.link ? `${t}\n\nDashboard: ${opts.link}` : t;
  const sentences = t.split(/(?<=[.!?])\s+(?=["“A-Z0-9$])/).map((s) => s.trim());
  const askAt = lastIndexWhere(sentences, (s) => ASKS.test(s) && /\bReply\b|\bText\b|\?\s*$/.test(s));
  const done = /\b(paid|refunded|moved|held in escrow|released|confirmed|recorded|thanks|sent)\b/i.test(t);
  const blocks: string[] = [];
  if (askAt >= 0) {
    const before = sentences.slice(0, askAt);
    const head = before.shift();
    if (head) blocks.push(head);
    if (before.length) blocks.push(before.join(" "));
    blocks.push(mark("ask", sentences.slice(askAt).join(" ")));
  } else if (sentences.length > 1) {
    blocks.push(mark(done ? "done" : "plain", sentences[0] as string), sentences.slice(1).join(" "));
  } else {
    blocks.push(mark(done ? "done" : "plain", t));
  }
  if (opts.link) blocks.push(`Dashboard: ${opts.link}`);
  return blocks.join("\n\n");
}
