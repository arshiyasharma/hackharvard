import { isOpen, lastCallHold, pendingOwnerAsks, policyFor, readOwnerDecision } from "@elves/engine";
import type { LLM } from "@elves/llm";
import type { Batch } from "@elves/pipeline";
import {
  type ElfName,
  onboardingActive,
  onboardingKey,
  parseOnboardingState,
  type Role,
  type Store,
} from "@elves/shared";
import { batchText, type Elf, hasPhotos } from "./contract.ts";
import { isCapabilitiesQuestion, isStatusAsk } from "./crew.ts";
import { counterpartyElf } from "./deal.ts";
import { isHomeContinuation, isHuntFollowUp } from "./home-followups.ts";
import { moveinAskKey, parseMoveinFollowUp } from "./home-movein.ts";
import { parsePriceCents } from "./intake.ts";

export type RouteVia =
  | "first_contact"
  | "onboarding"
  | "counterparty"
  | "thread"
  | "deal"
  | "followup"
  | "scope"
  | "photo"
  | "price"
  | "llm"
  | "keyword"
  | "default";
export interface RouteDecision {
  elf: ElfName;
  via: RouteVia;
  confidence: number;
}

export interface RouterDeps {
  store: Store;
  llm: LLM;
  elves: Elf[];
  /** Minimum LLM confidence to trust the classification over the keyword fallback. */
  minConfidence?: number;
  context?: string;
}

/** Keyword hits in `text`; a multi-word keyword counts double. */
export function keywordScore(text: string, keywords: string[]): number {
  const t = text.toLowerCase();
  let score = 0;
  for (const k of keywords) {
    const re = new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");
    if (re.test(t)) score += k.includes(" ") ? 2 : 1;
  }
  return score;
}

/** Keyword scoring: the Elf with the most keyword hits wins; ties go to the earlier Elf in the list. */
export function keywordRoute(text: string, elves: Elf[]): { elf: ElfName; score: number } | null {
  let best: { elf: ElfName; score: number } | null = null;
  for (const elf of elves) {
    const score = keywordScore(text, elf.keywords);
    if (score > 0 && (!best || score > best.score)) best = { elf: elf.name, score };
  }
  return best;
}

/** Thread-owner key for "the Elf that last replied in this space" (the shared pool has no real threads). */
export function spaceOwnerKey(spaceId: string): string {
  return `space:${spaceId}`;
}

/** Roles that text in about a deal; everyone else is crew. */
const COUNTERPARTY_ROLES: Role[] = ["buyer", "seller", "applicant", "lister"];

/**
 * Crew Lead routing: a counterparty (a buyer texting about a listing) always goes to the Elf that owns their
 * deal, never through classification; first contact in the owner chat always goes to the Crew Lead; a reply inside an Elf's
 * thread goes to that Elf; a "more" / "tell me about 2" after the Home Elf sent picks goes back to it;
 * otherwise the fast model classifies, with keywords as the fallback.
 */
export async function route(
  batch: Batch,
  deps: RouterDeps,
  opts: { firstContact: boolean; moveId?: string; role?: Role },
): Promise<RouteDecision> {
  if (opts.role && COUNTERPARTY_ROLES.includes(opts.role)) {
    const elf = (await counterpartyElf(deps, batch.spaceId)) ?? "stuff";
    if (deps.elves.some((e) => e.name === elf)) return { elf, via: "counterparty", confidence: 1 };
  }
  if (opts.firstContact) return { elf: "crew_lead", via: "first_contact", confidence: 1 };
  // Until the owner confirms the brief, every owner text is part of the onboarding call.
  if (opts.moveId && (opts.role ?? "owner") === "owner" && deps.elves.some((e) => e.name === "crew_lead")) {
    const state = parseOnboardingState(await deps.store.getCursor(onboardingKey(opts.moveId)));
    if (onboardingActive(state)) return { elf: "crew_lead", via: "onboarding", confidence: 1 };
  }

  const text = batchText(batch);
  // "status" is the Home Elf's (it has the checklist and the sublet); "what can you do?" is the Crew Lead's.
  // Both are answered from any thread.
  if ((opts.role ?? "owner") === "owner" && !hasPhotos(batch)) {
    if (isStatusAsk(text) && deps.elves.some((e) => e.name === "home"))
      return { elf: "home", via: "scope", confidence: 1 };
    if (isCapabilitiesQuestion(text) && deps.elves.some((e) => e.name === "crew_lead"))
      return { elf: "crew_lead", via: "scope", confidence: 1 };
  }

  for (const m of [...batch.messages].reverse()) {
    if (m.parentMessageId) {
      const owner = await deps.store.getThreadOwner(m.parentMessageId);
      if (owner && deps.elves.some((e) => e.name === owner))
        return { elf: owner, via: "thread", confidence: 1 };
    }
  }

  // "keep the couch" / "no last call" holds a price; the Elf that owns the deal records it.
  if (opts.moveId && lastCallHold(text)) {
    const open = (await deps.store.listDeals(opts.moveId)).find(
      (d) => policyFor(d.mode).lastCall && isOpen(d.state),
    );
    const elf = open ? policyFor(open.mode).elf : null;
    if (elf && deps.elves.some((e) => e.name === elf)) return { elf, via: "deal", confidence: 0.95 };
  }
  // "yes" / "no" / "$70" while a buyer's offer waits on the owner goes to the Elf that asked.
  if (opts.moveId && !hasPhotos(batch) && text.length <= 60 && readOwnerDecision(text)) {
    const pending = await pendingOwnerAsks(deps.store, opts.moveId);
    const elf = pending[0] ? policyFor(pending[0].deal.mode).elf : null;
    if (elf && deps.elves.some((e) => e.name === elf)) return { elf, via: "deal", confidence: 0.9 };
    if (readOwnerDecision(text)?.kind === "yes") {
      const events = await deps.store.listEvents(opts.moveId);
      for (let i = events.length - 1; i >= 0; i--) {
        const type = events[i]?.type;
        if (type === "buy.opened" || type === "donate.booked") break;
        if (type === "buy.pending" || type === "donate.pending")
          return { elf: "stuff", via: "deal", confidence: 0.9 };
      }
    }
  }
  // "2" after a list of picks is a pick, not a price. "search again" and a forwarded
  // listing link stay with Home when it spoke last, even with no number to pick.
  if (
    opts.moveId &&
    deps.elves.some((e) => e.name === "home") &&
    (isHuntFollowUp(text) || isHomeContinuation(text))
  ) {
    const lastElf = await deps.store.getThreadOwner(spaceOwnerKey(batch.spaceId));
    const hasPicks = !isHuntFollowUp(text) || (await deps.store.listListings(opts.moveId)).length > 0;
    if (lastElf === "home" && hasPicks) return { elf: "home", via: "followup", confidence: 0.95 };
  }
  // A date or address the Home Elf just asked for, or "done with internet" on its checklist, goes back to Home.
  if (opts.moveId && deps.elves.some((e) => e.name === "home") && text.trim()) {
    const lastElf = await deps.store.getThreadOwner(spaceOwnerKey(batch.spaceId));
    if (lastElf === "home") {
      const pending = await deps.store.getCursor(moveinAskKey(opts.moveId));
      const onList =
        !pending &&
        parseMoveinFollowUp(text) != null &&
        (await deps.store.listMoveinTasks(opts.moveId)).length > 0;
      if (pending || onList) return { elf: "home", via: "followup", confidence: 0.95 };
    }
  }
  // Room photos while Home is writing the owner's sublet post are for the post, not for sale.
  if (opts.moveId && hasPhotos(batch) && deps.elves.some((e) => e.name === "home")) {
    const lastElf = await deps.store.getThreadOwner(spaceOwnerKey(batch.spaceId));
    if (lastElf === "home") {
      const post = await deps.store.getSubletPost(opts.moveId);
      if (post && post.status !== "approved") return { elf: "home", via: "followup", confidence: 0.95 };
    }
  }
  // Photos and bare prices are the Stuff Elf's job; no model call needed.
  if (hasPhotos(batch) && deps.elves.some((e) => e.name === "stuff"))
    return { elf: "stuff", via: "photo", confidence: 0.95 };
  const plain = batch.messages
    .map((m) => m.text ?? "")
    .join(" ")
    .trim();
  if (
    plain &&
    plain.length <= 40 &&
    parsePriceCents(plain) != null &&
    deps.elves.some((e) => e.name === "stuff") &&
    (keywordRoute(text, deps.elves)?.elf ?? "stuff") === "stuff"
  ) {
    return { elf: "stuff", via: "price", confidence: 0.9 };
  }
  if (!text.trim()) return { elf: "crew_lead", via: "default", confidence: 0.5 };

  const min = deps.minConfidence ?? 0.5;
  if (deps.llm.name !== "fake") {
    try {
      const res = await deps.llm.classify({
        text,
        context: deps.context ?? "",
        options: deps.elves.map((e) => ({ id: e.name, description: e.description })),
      });
      if (deps.elves.some((e) => e.name === res.id) && res.confidence >= min) {
        return { elf: res.id as ElfName, via: "llm", confidence: res.confidence };
      }
    } catch {
      // fall through to keywords
    }
  }
  const kw = keywordRoute(text, deps.elves);
  if (kw) return { elf: kw.elf, via: "keyword", confidence: Math.min(0.9, 0.5 + kw.score * 0.1) };
  return { elf: "crew_lead", via: "default", confidence: 0.4 };
}
