import type { ModePolicy } from "./policy.ts";

/** The deal's terms as the engine sees them; the counterparty never sees `limit`. */
export interface Terms {
  /** Our standing price: list price (sell) or opening offer (buy). */
  ask: number;
  /** Owner's floor (sell) or ceiling (buy). */
  limit: number;
}

/** Where this counterparty stands. */
export interface PartyPosition {
  rounds: number;
  lastOffer: number | null;
  lastCounter: number | null;
  /** The owner allowed this party past the limit, down (or up) to here. */
  ownerApproved: number | null;
}

export type Decision =
  /** Take their number. */
  | { kind: "accept"; cents: number }
  /** Our next number; always on the owner's side of the limit. */
  | { kind: "counter"; cents: number }
  /** Their number is past the limit and they are not moving: ask the owner, hold `hold` meanwhile. */
  | { kind: "ask_owner"; offer: number; hold: number }
  /** No number from them: restate where we stand. */
  | { kind: "hold"; cents: number };

/** How good `x` is for the owner: bigger is better in every mode. */
const u = (p: ModePolicy, x: number) => p.dir * x;

/** The line for this party: the owner's approval when they gave one, else the deal's limit. */
export function effectiveLimit(p: ModePolicy, t: Terms, pos: PartyPosition): number {
  if (pos.ownerApproved == null) return t.limit;
  return u(p, pos.ownerApproved) < u(p, t.limit) ? pos.ownerApproved : t.limit;
}

/** Is `x` on the owner's side of (or at) the line? */
export function withinLimit(p: ModePolicy, x: number, limit: number): boolean {
  return u(p, x) >= u(p, limit);
}

/** Round toward the owner's side to a number people say out loud ($65, $1,225). */
export function friendly(cents: number, dir: 1 | -1): number {
  const step = cents >= 100_000 ? 2_500 : cents >= 2_000 ? 500 : 100;
  return (dir === 1 ? Math.ceil(cents / step) : Math.floor(cents / step)) * step;
}

/** Close enough that haggling further looks petty: 5% of the ask or $5, whichever is more. */
function petty(t: Terms, gap: number): boolean {
  return gap <= Math.max(Math.round(t.ask * 0.05), 500);
}

/**
 * One negotiation step. Deterministic, and the invariant every mode relies on: an accept or a counter is never
 * past the effective limit. When the counterparty sits past it and will not move, the decision is ask_owner.
 */
export function decide(
  p: ModePolicy,
  t: Terms,
  pos: PartyPosition,
  offer: number | null,
  opts: { final?: boolean } = {},
): Decision {
  const limit = effectiveLimit(p, t, pos);
  const standing = pos.lastCounter ?? t.ask;
  if (offer == null) return { kind: "hold", cents: standing };
  if (u(p, offer) >= u(p, standing)) return { kind: "accept", cents: offer };

  const gap = u(p, standing) - u(p, offer);
  if (withinLimit(p, offer, limit)) {
    if (opts.final || pos.rounds >= p.maxRounds || petty(t, gap)) return { kind: "accept", cents: offer };
    return { kind: "counter", cents: clampCounter(p, standing - p.dir * gap * p.concession, offer, standing, limit) };
  }

  // Past the line. A first lowball gets a counter; a repeat, a "final", or no movement goes to the owner.
  const notMoving = pos.lastOffer != null && u(p, offer) <= u(p, pos.lastOffer);
  const atLine = standing === limit;
  if (opts.final || (pos.rounds >= 1 && (notMoving || atLine)) || pos.rounds >= p.maxRounds + 1) {
    return { kind: "ask_owner", offer, hold: standing };
  }
  const target = standing - p.dir * gap * p.concession;
  const counter = withinLimit(p, target, limit) ? target : limit;
  return { kind: "counter", cents: clampCounter(p, counter, offer, standing, limit) };
}

/** Friendly-round a counter, then keep it between their offer and our standing price, on our side of the line. */
function clampCounter(p: ModePolicy, raw: number, offer: number, standing: number, limit: number): number {
  let c = friendly(Math.round(raw), p.dir);
  if (u(p, c) > u(p, standing)) c = standing;
  if (!withinLimit(p, c, limit)) c = limit;
  // A counter equal to (or worse than) their offer is an accept in disguise; the caller would rather say yes.
  if (u(p, c) <= u(p, offer)) c = withinLimit(p, offer, limit) ? offer : limit;
  return c;
}
