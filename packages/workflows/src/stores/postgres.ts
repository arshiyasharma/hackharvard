import type { SQL } from "bun";
import type { Deal, EngineStore, LastCallRow } from "../types.ts";

type Row = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const json = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);

function dealRow(r: Row): Deal {
  return {
    id: r.id as string,
    moveId: r.move_id as string,
    itemId: r.item_id as string,
    itemName: r.item_name as string,
    runId: (r.run_id as string | null) ?? null,
    buyerHandle: (r.buyer_handle as string | null) ?? null,
    buyerSpaceId: (r.buyer_space_id as string | null) ?? null,
    buyerAgentId: (r.buyer_agent_id as string | null) ?? null,
    status: r.status as Deal["status"],
    stage: r.stage as Deal["stage"],
    listCents: Number(r.list_cents),
    floorCents: num(r.floor_cents),
    lastOfferCents: num(r.last_offer_cents),
    counterCents: num(r.counter_cents),
    counters: Number(r.counters ?? 0),
    agreedCents: num(r.agreed_cents),
    offeredSlots: (json(r.offered_slots) as Deal["offeredSlots"]) ?? [],
    slotAt: (r.slot_at as string | null) ?? null,
    reschedules: Number(r.reschedules ?? 0),
    nudges: Number(r.nudges ?? 0),
    buyerConfirmed: Boolean(r.buyer_confirmed),
    ownerConfirmed: Boolean(r.owner_confirmed),
    reliability: Number(r.reliability ?? 0.7),
    lastBuyerAt: isoOrNull(r.last_buyer_at),
    lastCallOptOut: Boolean(r.last_call_opt_out),
    lastCallStage: r.last_call_stage as Deal["lastCallStage"],
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
function lastCallRow(r: Row): LastCallRow {
  return {
    moveId: r.move_id as string,
    runId: r.run_id as string,
    stage: r.stage as LastCallRow["stage"],
    status: r.status as LastCallRow["status"],
    fired: ((json(r.fired) as string[]) ?? []).map(String),
    updatedAt: iso(r.updated_at),
  };
}

export class PostgresEngineStore implements EngineStore {
  readonly kind = "postgres" as const;
  constructor(private readonly sql: SQL) {}

  async getDeal(id: string) {
    const rows = await this.sql`select * from deal_runs where id = ${id}`;
    return rows[0] ? dealRow(rows[0]) : null;
  }
  async saveDeal(d: Deal) {
    const rows = await this.sql`
      insert into deal_runs (id, move_id, item_id, item_name, run_id, buyer_handle, buyer_space_id, buyer_agent_id, status, stage,
        list_cents, floor_cents, last_offer_cents, counter_cents, counters, agreed_cents, offered_slots, slot_at, reschedules,
        nudges, buyer_confirmed, owner_confirmed, reliability, last_buyer_at, last_call_opt_out, last_call_stage, created_at, updated_at)
      values (${d.id}, ${d.moveId}, ${d.itemId}, ${d.itemName}, ${d.runId}, ${d.buyerHandle}, ${d.buyerSpaceId}, ${d.buyerAgentId},
        ${d.status}, ${d.stage}, ${d.listCents}, ${d.floorCents}, ${d.lastOfferCents}, ${d.counterCents}, ${d.counters}, ${d.agreedCents},
        ${JSON.stringify(d.offeredSlots)}::jsonb, ${d.slotAt}, ${d.reschedules}, ${d.nudges}, ${d.buyerConfirmed}, ${d.ownerConfirmed},
        ${d.reliability}, ${d.lastBuyerAt}::timestamptz, ${d.lastCallOptOut}, ${d.lastCallStage}, ${d.createdAt}::timestamptz, now())
      on conflict (id) do update set
        run_id = excluded.run_id, buyer_handle = excluded.buyer_handle, buyer_space_id = excluded.buyer_space_id,
        buyer_agent_id = excluded.buyer_agent_id, status = excluded.status, stage = excluded.stage, list_cents = excluded.list_cents,
        floor_cents = excluded.floor_cents, last_offer_cents = excluded.last_offer_cents, counter_cents = excluded.counter_cents,
        counters = excluded.counters, agreed_cents = excluded.agreed_cents, offered_slots = excluded.offered_slots,
        slot_at = excluded.slot_at, reschedules = excluded.reschedules, nudges = excluded.nudges,
        buyer_confirmed = excluded.buyer_confirmed, owner_confirmed = excluded.owner_confirmed, reliability = excluded.reliability,
        last_buyer_at = excluded.last_buyer_at, last_call_opt_out = excluded.last_call_opt_out,
        last_call_stage = excluded.last_call_stage, updated_at = now()
      returning *`;
    return dealRow(rows[0] as Row);
  }
  async listDeals(moveId: string) {
    return (await this.sql`select * from deal_runs where move_id = ${moveId} order by seq`).map(dealRow);
  }
  async dealsForItem(itemId: string) {
    return (await this.sql`select * from deal_runs where item_id = ${itemId} order by seq`).map(dealRow);
  }
  async dealForBuyerSpace(spaceId: string) {
    const rows = await this.sql`select * from deal_runs where buyer_space_id = ${spaceId} order by seq desc limit 1`;
    return rows[0] ? dealRow(rows[0]) : null;
  }
  async getLastCall(moveId: string) {
    const rows = await this.sql`select * from last_call_runs where move_id = ${moveId}`;
    return rows[0] ? lastCallRow(rows[0]) : null;
  }
  async saveLastCall(row: LastCallRow) {
    const rows = await this.sql`
      insert into last_call_runs (move_id, run_id, stage, status, fired) values (${row.moveId}, ${row.runId}, ${row.stage}, ${row.status}, ${JSON.stringify(row.fired)}::jsonb)
      on conflict (move_id) do update set run_id = excluded.run_id, stage = excluded.stage, status = excluded.status, fired = excluded.fired, updated_at = now()
      returning *`;
    return lastCallRow(rows[0] as Row);
  }
  async listWaitingLastCalls() {
    return (await this.sql`select * from last_call_runs where status = 'waiting' order by created_at`).map(lastCallRow);
  }
}
