/** Short replies to a list of picks: "more", "tell me about 2", "skip 1", "save 3". */
export type FollowUp =
  | { kind: "more" }
  | { kind: "detail" | "skip" | "shortlist" | "reach"; n: number };

const MORE = /^(?:more|next|show me more|any more|anything else|what else|others?|more options)\s*[?!.]*$/i;
const DETAIL =
  /^(?:tell me (?:more )?about|more (?:on|about)|details?(?: on| for| about)?|what about|open|show me|link (?:for|to)|number|how about)\s*#?\s*(\d{1,2})\s*[?!.]*$/i;
const BARE = /^#?\s*(\d{1,2})\s*[?!.]*$/;
const SKIP = /^(?:skip|pass(?: on)?|not|nah(?: to)?|no to|remove|drop|hide)\s*#?\s*(\d{1,2})\s*[?!.]*$/i;
const SHORTLIST =
  /^(?:shortlist|save|keep|like|star|favorite|favourite|fav|i like|love|i want|interested in)\s*#?\s*(\d{1,2})\s*[?!.]*$/i;
const REACH =
  /^(?:yes[, ]+)?(?:reach out(?: to)?|contact|message|text them about)\s*#?\s*(\d{1,2})\s*[?!.]*$/i;

export function parseFollowUp(text: string): FollowUp | null {
  const t = text.trim();
  if (!t || t.length > 40) return null;
  if (MORE.test(t)) return { kind: "more" };
  const skip = t.match(SKIP);
  if (skip?.[1]) return { kind: "skip", n: Number(skip[1]) };
  const save = t.match(SHORTLIST);
  if (save?.[1]) return { kind: "shortlist", n: Number(save[1]) };
  const reach = t.match(REACH);
  if (reach?.[1]) return { kind: "reach", n: Number(reach[1]) };
  const detail = t.match(DETAIL) ?? t.match(BARE);
  if (detail?.[1]) return { kind: "detail", n: Number(detail[1]) };
  return null;
}

/** True when the text only makes sense as a reply to a list of picks (the router checks who sent the list). */
export function isHuntFollowUp(text: string): boolean {
  return parseFollowUp(text) != null;
}

const REFRESH = /\b(?:search|look|try) again\b|\bretry(?: the search)?\b/i;

/** "search again" should run a new search, not replay the picks from the last few minutes. */
export function wantsFreshSearch(text: string): boolean {
  return REFRESH.test(text.trim());
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** Listing links the owner pasted or forwarded. Trailing punctuation is stripped. */
export function extractListingUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,);]+$/, "");
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** A hunt the Home Elf already started: retry the search, or rank a link the owner just sent. */
export function isHomeContinuation(text: string): boolean {
  return wantsFreshSearch(text) || extractListingUrls(text).length > 0;
}
