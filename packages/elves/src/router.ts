import type { LLM } from "@elves/llm";
import type { Batch } from "@elves/pipeline";
import type { ElfName, Store } from "@elves/shared";
import { batchText, type Elf } from "./contract.ts";

export type RouteVia = "first_contact" | "thread" | "llm" | "keyword" | "default";
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

/** Keyword scoring: the Elf with the most keyword hits wins; ties go to the earlier Elf in the list. */
export function keywordRoute(text: string, elves: Elf[]): { elf: ElfName; score: number } | null {
  const t = text.toLowerCase();
  let best: { elf: ElfName; score: number } | null = null;
  for (const elf of elves) {
    let score = 0;
    for (const k of elf.keywords) {
      const re = new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");
      if (re.test(t)) score += k.includes(" ") ? 2 : 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { elf: elf.name, score };
  }
  return best;
}

/**
 * Crew Lead routing: first contact in the owner chat always goes to the Crew Lead; a reply inside an Elf's
 * thread goes to that Elf; otherwise the fast model classifies, with keywords as the fallback.
 */
export async function route(
  batch: Batch,
  deps: RouterDeps,
  opts: { firstContact: boolean },
): Promise<RouteDecision> {
  if (opts.firstContact) return { elf: "crew_lead", via: "first_contact", confidence: 1 };

  for (const m of [...batch.messages].reverse()) {
    if (m.parentMessageId) {
      const owner = await deps.store.getThreadOwner(m.parentMessageId);
      if (owner) return { elf: owner, via: "thread", confidence: 1 };
    }
  }

  const text = batchText(batch);
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
