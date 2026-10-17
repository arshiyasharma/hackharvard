/**
 * @elves/engine — the Deal Engine. Every moving chore that ends in a hand-off (sell a couch, buy a desk, sublet
 * the room, find a sublet) is the same loop, so it is built once and run in four modes:
 *
 *   list → hear from a counterparty in their own space → negotiate inside the owner's line → schedule from the
 *   shared calendar → hand off with evidence → close with an outcome tag
 *
 * Decisions are deterministic (prices, transitions, slots, Scam Shield); the Elves only put them into words, so
 * a model can never agree past the owner's floor or ceiling. State lives in the Store (deals, deal_parties).
 */
export * from "./calendar.ts";
export * from "./deals.ts";
export * from "./intent.ts";
export * from "./machine.ts";
export * from "./negotiate.ts";
export * from "./policy.ts";
export * from "./shield.ts";
export * from "./voice.ts";
