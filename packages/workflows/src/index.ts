/**
 * @elves/workflows — the Deal Engine and Last Call on Mastra Workflows.
 *
 *   rules.ts      the rules, pure and fixture-tested (negotiation band, floor, owner escalation, slots, hand-off)
 *   workflows.ts  Mastra workflows: one durable run per deal (negotiating → scheduling → handoff) and one per
 *                 move for Last Call (drop → free → close); runs persist in Mastra storage (Postgres in prod)
 *   engine.ts     DealEngine: identifies buyers, routes events into runs, fires Last Call stages, returns Effects
 *   stores/       the queryable deal_runs and last_call_runs rows (in-memory or Postgres, migration 0005)
 */
export {
  type BuyerMatch,
  DealEngine,
  type DealEngineOptions,
  type EngineConfig,
  matchItem,
} from "./engine.ts";
export {
  applyEvent,
  type BuyerIntent,
  buyerIntent,
  fmtUsd,
  LAST_CALL_HOURS,
  lastCallPrice,
  midpoint,
  parsePriceCents,
  parseSlotPick,
} from "./rules.ts";
export { proposeSlots, rulesFromFacts, type SlotRules, zoned } from "./slots.ts";
export { InMemoryEngineStore } from "./stores/inmemory.ts";
export { PostgresEngineStore } from "./stores/postgres.ts";
export * from "./types.ts";
export { createDealWorkflow, createEngineMastra, createLastCallWorkflow } from "./workflows.ts";
