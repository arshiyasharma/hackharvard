import type { ElfName } from "@elves/shared";
import type { Elf, ElfContext, ElfResult } from "./contract.ts";

/**
 * How Elves call each other. The service routes every batch to ONE Elf; when that Elf needs another's work in the
 * same turn (the Crew Lead handing one text to Stuff and Home, Home asking Stuff for its pickups), it calls through
 * this registry by name. The registry is filled once by `allElves` in index.ts, so no Elf imports another and
 * nothing is circular; tests can register their own set.
 */

const REGISTRY = new Map<ElfName, Elf>();

export function registerElves(elves: Elf[]): void {
  for (const e of elves) REGISTRY.set(e.name, e);
}

export function elfByName(name: ElfName): Elf | undefined {
  return REGISTRY.get(name);
}

/** Run one Elf on this turn's batch, or null when it is not on the crew. */
export async function callElf(ctx: ElfContext, name: ElfName): Promise<ElfResult | null> {
  const elf = REGISTRY.get(name);
  return elf ? elf.handle(ctx) : null;
}

/**
 * Run several Elves on the same batch, in order, and hand back one result: replies and outbound texts in order,
 * every event, the move patches merged. Each Elf's own board row is patched here, because the service only
 * patches the row of the Elf it routed to.
 */
export async function callElves(ctx: ElfContext, names: ElfName[]): Promise<ElfResult> {
  const out: Required<Pick<ElfResult, "replies" | "events" | "outbound" | "movePatch">> = {
    replies: [],
    events: [],
    outbound: [],
    movePatch: {},
  };
  for (const name of names) {
    if (ctx.signal.aborted) break;
    const elf = REGISTRY.get(name);
    if (!elf) continue;
    const r = await elf.handle(ctx);
    out.replies.push(...r.replies.map((x) => ({ ...x, elf: x.elf ?? elf.name })));
    out.events.push(...(r.events ?? []));
    out.outbound.push(...(r.outbound ?? []).map((x) => ({ ...x, elf: x.elf ?? elf.name })));
    Object.assign(out.movePatch, r.movePatch ?? {});
    if (r.boardPatch) await ctx.store.patchBoard(ctx.move.id, elf.name, r.boardPatch);
  }
  return out;
}
