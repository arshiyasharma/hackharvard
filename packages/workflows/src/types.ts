import type { Item } from "@elves/shared";

export type DealStatus =
  | "listed"
  | "negotiating"
  | "awaiting_owner"
  | "scheduled"
  | "handed_off"
  | "paid"
  | "relisted"
  | "withdrawn"
  | "waiting";
export type DealStage = "negotiating" | "scheduling" | "handoff" | "done";
export type LastCallStage = "drop" | "free" | "close" | "done";

export interface Slot {
  start: string;
  end: string;
  label: string;
}

export interface Deal {
  id: string;
  moveId: string;
  itemId: string;
  itemName: string;
  runId: string | null;
  buyerHandle: string | null;
  buyerSpaceId: string | null;
  buyerAgentId: string | null;
  status: DealStatus;
  stage: DealStage;
  listCents: number;
  floorCents: number | null;
  lastOfferCents: number | null;
  counterCents: number | null;
  counters: number;
  agreedCents: number | null;
  offeredSlots: Slot[];
  slotAt: string | null;
  reschedules: number;
  nudges: number;
  buyerConfirmed: boolean;
  ownerConfirmed: boolean;
  reliability: number;
  lastBuyerAt: string | null;
  lastCallOptOut: boolean;
  lastCallStage: "none" | "dropped" | "free";
  createdAt: string;
  updatedAt: string;
}

export interface LastCallRow {
  moveId: string;
  runId: string;
  stage: LastCallStage;
  status: "waiting" | "done";
  fired: string[];
  updatedAt: string;
}

/** What happened to a deal in response to one event; the engine turns it into texts and events. */
export interface Reply {
  to: "buyer" | "owner";
  text: string;
}
export interface Transition {
  deal: Deal;
  replies: Reply[];
  events: { type: string; payload: Record<string, unknown> }[];
  itemPatch?: Partial<Item>;
  /** The buyer's confirmation created an escrow hold, or the hand-off released it. */
  money?: "hold" | "release" | "refund";
}

export type DealEvent =
  | { kind: "buyer_text"; text: string; at: string }
  | { kind: "owner_decision"; approved: boolean }
  | { kind: "owner_noshow" }
  | { kind: "owner_handoff" }
  | { kind: "owner_withdraw" }
  | { kind: "owner_optout" }
  | { kind: "price_change"; listCents: number; floorCents: number | null; why: "dropped" | "free" }
  | { kind: "promote" };

export interface PolicyContext {
  now: Date;
  /** Fresh pickup slots when a deal needs to offer some. */
  slots: () => Slot[];
}

export interface OutboundText {
  audience: "buyer" | "owner";
  spaceId: string;
  senderId: string;
  text: string;
}

export interface Effects {
  messages: OutboundText[];
  events: { type: string; payload: Record<string, unknown> }[];
  /** Crew Board updates the engine wants applied (Stuff Elf status lines). */
  board: { elf: "stuff"; currentTask?: string; lastUpdate?: string; status?: "working" | "waiting" | "done" }[];
}

export const emptyEffects = (): Effects => ({ messages: [], events: [], board: [] });

export interface EngineStore {
  readonly kind: "memory" | "postgres";
  getDeal(id: string): Promise<Deal | null>;
  saveDeal(deal: Deal): Promise<Deal>;
  listDeals(moveId: string): Promise<Deal[]>;
  dealsForItem(itemId: string): Promise<Deal[]>;
  dealForBuyerSpace(spaceId: string): Promise<Deal | null>;
  getLastCall(moveId: string): Promise<LastCallRow | null>;
  saveLastCall(row: LastCallRow): Promise<LastCallRow>;
  listWaitingLastCalls(): Promise<LastCallRow[]>;
}

export const OPEN_STATUSES: DealStatus[] = ["listed", "negotiating", "awaiting_owner", "scheduled", "handed_off"];
export const isOpen = (d: Deal) => OPEN_STATUSES.includes(d.status);
/** A deal that blocks other buyers: someone is actively negotiating or has a pickup booked. */
export const isClaimed = (d: Deal) =>
  d.status === "negotiating" || d.status === "awaiting_owner" || d.status === "scheduled" || d.status === "handed_off";
