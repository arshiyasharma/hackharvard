import {
  ELF_NAMES,
  type ElfName,
  type ElfStatusRow,
  type EventRow,
  type HousingSearch,
  type Item,
  itemDefaults,
  type Listing,
  listingDefaults,
  type Move,
  newId,
  type Participant,
  type SendRecord,
  type Store,
} from "@elves/shared";
import type { SQL } from "bun";

type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const json = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);

function moveRow(r: Row): Move {
  return {
    id: r.id as string,
    ownerHandle: r.owner_handle as string,
    ownerSpaceId: r.owner_space_id as string,
    platform: r.platform as string,
    name: str(r.name),
    moveOutAt: str(r.move_out_at),
    moveInAt: str(r.move_in_at),
    fromAddress: str(r.from_address),
    toAddress: str(r.to_address),
    boardLinkSent: Boolean(r.board_link_sent),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function participantRow(r: Row): Participant {
  return {
    id: r.id as string,
    moveId: r.move_id as string,
    handle: r.handle as string,
    role: r.role as Participant["role"],
    spaceId: r.space_id as string,
    platform: r.platform as string,
    agentUserId: str(r.agent_user_id),
    createdAt: iso(r.created_at),
  };
}

function boardRow(r: Row): ElfStatusRow {
  return {
    moveId: r.move_id as string,
    elf: r.elf as ElfName,
    status: r.status as ElfStatusRow["status"],
    currentTask: (r.current_task as string) ?? "",
    lastUpdate: (r.last_update as string) ?? "",
    updatedAt: iso(r.updated_at),
  };
}

function eventRow(r: Row): EventRow {
  return {
    id: r.id as string,
    moveId: str(r.move_id),
    type: r.type as string,
    payload: (json(r.payload) ?? {}) as Record<string, unknown>,
    traceId: str(r.trace_id),
    createdAt: iso(r.created_at),
  };
}

function itemRow(r: Row): Item {
  return {
    id: r.id as string,
    moveId: r.move_id as string,
    name: r.name as string,
    category: r.category as string,
    weightLb: Number(r.weight_lb),
    title: str(r.title),
    description: str(r.description),
    condition: str(r.condition),
    priceLowCents: num(r.price_low_cents),
    priceHighCents: num(r.price_high_cents),
    listPriceCents: num(r.list_price_cents),
    floorPriceCents: num(r.floor_price_cents),
    photoAttachmentIds: ((json(r.photo_attachment_ids) as string[]) ?? []).map(String),
    listingApproved: Boolean(r.listing_approved),
    outcome: r.outcome as Item["outcome"],
    intent: ((r.intent as string) ?? "sell") as Item["intent"],
    outcomeAt: r.outcome_at == null ? null : iso(r.outcome_at),
    leavesBeforeMoveDay: Boolean(r.leaves_before_move_day),
    lastCallStage: str(r.last_call_stage) as Item["lastCallStage"],
    createdAt: iso(r.created_at),
  };
}

function searchRow(r: Row): HousingSearch {
  return {
    moveId: r.move_id as string,
    kinds: ((json(r.kinds) as HousingSearch["kinds"]) ?? []).slice(),
    city: str(r.city),
    neighborhoods: ((json(r.neighborhoods) as string[]) ?? []).map(String),
    budgetMaxCents: num(r.budget_max_cents),
    hotelNightlyMaxCents: num(r.hotel_nightly_max_cents),
    moveIn: str(r.move_in),
    moveOut: str(r.move_out),
    bedrooms: num(r.bedrooms),
    furnished: r.furnished == null ? null : Boolean(r.furnished),
    mustHaves: ((json(r.must_haves) as string[]) ?? []).map(String),
    notes: ((json(r.notes) as string[]) ?? []).map(String),
    lastSearchedAt: str(r.last_searched_at),
    lastSearchKey: str(r.last_search_key),
    shownCount: Number(r.shown_count ?? 0),
    updatedAt: iso(r.updated_at),
  };
}

function listingRow(r: Row): Listing {
  const contact = (json(r.contact) as Partial<Listing["contact"]>) ?? {};
  return {
    id: r.id as string,
    moveId: r.move_id as string,
    site: r.site as string,
    kind: r.kind as Listing["kind"],
    url: r.url as string,
    title: r.title as string,
    priceCents: num(r.price_cents),
    priceUnit: (r.price_unit as Listing["priceUnit"]) ?? "month",
    location: str(r.location),
    availableFrom: str(r.available_from),
    bedrooms: num(r.bedrooms),
    snippet: str(r.snippet),
    postedAt: str(r.posted_at),
    photoCount: num(r.photo_count),
    contact: {
      phone: contact.phone ?? null,
      email: contact.email ?? null,
      messageUrl: contact.messageUrl ?? null,
    },
    scamFlags: ((json(r.scam_flags) as string[]) ?? []).map(String),
    score: Number(r.score ?? 0),
    reason: (r.reason as string) ?? "",
    rank: num(r.rank),
    status: r.status as Listing["status"],
    foundAt: iso(r.found_at),
    createdAt: iso(r.created_at),
  };
}

/**
 * The Store on Postgres. Every write is an upsert keyed on the row's id, so retries and replays are harmless.
 * Patches read-merge-write in JS to keep the SQL static; rows are tiny and the service runs one batch per
 * space at a time.
 */
export class PostgresStore implements Store {
  constructor(private readonly sql: SQL) {}

  async getMove(id: string) {
    const rows = await this.sql`select * from moves where id = ${id}`;
    return rows[0] ? moveRow(rows[0]) : undefined;
  }
  async getMoveBySpace(spaceId: string) {
    const rows = await this.sql`
      select m.* from moves m where m.owner_space_id = ${spaceId}
      union all
      select m.* from moves m join participants p on p.move_id = m.id where p.space_id = ${spaceId}
      limit 1`;
    return rows[0] ? moveRow(rows[0]) : undefined;
  }
  async getMoveByOwnerHandle(handle: string) {
    const rows = await this.sql`select * from moves where owner_handle = ${handle} order by seq limit 1`;
    return rows[0] ? moveRow(rows[0]) : undefined;
  }
  async listMoves() {
    return (await this.sql`select * from moves order by seq`).map(moveRow);
  }
  async createMove(input: Pick<Move, "ownerHandle" | "ownerSpaceId" | "platform"> & { id?: string }) {
    const id = input.id ?? newId("mv");
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        insert into moves (id, owner_handle, owner_space_id, platform)
        values (${id}, ${input.ownerHandle}, ${input.ownerSpaceId}, ${input.platform})
        returning *`;
      const board = ELF_NAMES.map((elf) => ({
        move_id: id,
        elf,
        status: elf === "crew_lead" ? "working" : "idle",
        current_task: elf === "crew_lead" ? "Getting the move set up" : "Standing by",
        last_update: "",
      }));
      await tx`insert into elf_status ${tx(board)} on conflict (move_id, elf) do nothing`;
      return moveRow(rows[0] as Row);
    });
  }
  async updateMove(id: string, patch: Partial<Omit<Move, "id" | "createdAt">>) {
    const current = await this.getMove(id);
    if (!current) throw new Error(`move ${id} not found`);
    const next = { ...current, ...patch };
    const rows = await this.sql`
      update moves set
        owner_handle = ${next.ownerHandle}, owner_space_id = ${next.ownerSpaceId}, platform = ${next.platform},
        name = ${next.name}, move_out_at = ${next.moveOutAt}, move_in_at = ${next.moveInAt},
        from_address = ${next.fromAddress}, to_address = ${next.toAddress}, board_link_sent = ${next.boardLinkSent},
        updated_at = now()
      where id = ${id} returning *`;
    return moveRow(rows[0] as Row);
  }

  async upsertParticipant(input: Omit<Participant, "id" | "createdAt">) {
    const rows = await this.sql`
      insert into participants (id, move_id, handle, role, space_id, platform, agent_user_id)
      values (${newId("pt")}, ${input.moveId}, ${input.handle}, ${input.role}, ${input.spaceId}, ${input.platform}, ${input.agentUserId})
      on conflict (space_id) do update set
        move_id = excluded.move_id, handle = excluded.handle, role = excluded.role,
        platform = excluded.platform, agent_user_id = excluded.agent_user_id
      returning *`;
    return participantRow(rows[0] as Row);
  }
  async getParticipantBySpace(spaceId: string) {
    const rows = await this.sql`select * from participants where space_id = ${spaceId}`;
    return rows[0] ? participantRow(rows[0]) : undefined;
  }
  async listParticipants(moveId: string) {
    return (await this.sql`select * from participants where move_id = ${moveId} order by seq`).map(
      participantRow,
    );
  }

  async getBoard(moveId: string) {
    const rows: ElfStatusRow[] = (await this.sql`select * from elf_status where move_id = ${moveId}`).map(
      boardRow,
    );
    const order = new Map(ELF_NAMES.map((e, i) => [e, i] as const));
    return rows.sort((a, b) => (order.get(a.elf) ?? 99) - (order.get(b.elf) ?? 99));
  }
  async patchBoard(
    moveId: string,
    elf: ElfName,
    patch: Partial<Omit<ElfStatusRow, "moveId" | "elf" | "updatedAt">>,
  ) {
    const existing = (await this.sql`select * from elf_status where move_id = ${moveId} and elf = ${elf}`)[0];
    const base: ElfStatusRow = existing
      ? boardRow(existing)
      : { moveId, elf, status: "idle", currentTask: "", lastUpdate: "", updatedAt: "" };
    const next = { ...base, ...patch };
    const rows = await this.sql`
      insert into elf_status (move_id, elf, status, current_task, last_update, updated_at)
      values (${moveId}, ${elf}, ${next.status}, ${next.currentTask}, ${next.lastUpdate}, now())
      on conflict (move_id, elf) do update set
        status = excluded.status, current_task = excluded.current_task, last_update = excluded.last_update, updated_at = now()
      returning *`;
    return boardRow(rows[0] as Row);
  }

  async appendEvent(input: Omit<EventRow, "id" | "createdAt">) {
    const rows = await this.sql`
      insert into events (id, move_id, type, payload, trace_id)
      values (${newId("ev")}, ${input.moveId}, ${input.type}, ${JSON.stringify(input.payload ?? {})}::jsonb, ${input.traceId})
      returning *`;
    return eventRow(rows[0] as Row);
  }
  async listEvents(moveId: string) {
    return (await this.sql`select * from events where move_id = ${moveId} order by seq`).map(eventRow);
  }

  async listItems(moveId: string) {
    return (await this.sql`select * from items where move_id = ${moveId} order by seq`).map(itemRow);
  }
  async upsertItem(input: Partial<Item> & Pick<Item, "moveId" | "name" | "category">) {
    const id = input.id ?? newId("it");
    const prevRow = input.id ? (await this.sql`select * from items where id = ${id}`)[0] : undefined;
    const prev = prevRow ? itemRow(prevRow) : undefined;
    const item: Item = { ...itemDefaults(), ...(prev ?? {}), ...input, id };
    const rows = await this.sql`
      insert into items (id, move_id, name, category, weight_lb, title, description, condition,
        price_low_cents, price_high_cents, list_price_cents, floor_price_cents, photo_attachment_ids,
        listing_approved, outcome, intent, outcome_at, leaves_before_move_day, last_call_stage)
      values (${id}, ${item.moveId}, ${item.name}, ${item.category}, ${item.weightLb}, ${item.title}, ${item.description},
        ${item.condition}, ${item.priceLowCents}, ${item.priceHighCents}, ${item.listPriceCents}, ${item.floorPriceCents},
        ${JSON.stringify(item.photoAttachmentIds)}::jsonb, ${item.listingApproved}, ${item.outcome}, ${item.intent},
        ${item.outcomeAt}::timestamptz, ${item.leavesBeforeMoveDay}, ${item.lastCallStage})
      on conflict (id) do update set
        move_id = excluded.move_id, name = excluded.name, category = excluded.category, weight_lb = excluded.weight_lb,
        title = excluded.title, description = excluded.description, condition = excluded.condition,
        price_low_cents = excluded.price_low_cents, price_high_cents = excluded.price_high_cents,
        list_price_cents = excluded.list_price_cents, floor_price_cents = excluded.floor_price_cents,
        photo_attachment_ids = excluded.photo_attachment_ids, listing_approved = excluded.listing_approved,
        outcome = excluded.outcome, intent = excluded.intent, outcome_at = excluded.outcome_at,
        leaves_before_move_day = excluded.leaves_before_move_day, last_call_stage = excluded.last_call_stage
      returning *`;
    return itemRow(rows[0] as Row);
  }

  async getSearch(moveId: string) {
    const rows = await this.sql`select * from housing_searches where move_id = ${moveId}`;
    return rows[0] ? searchRow(rows[0]) : undefined;
  }
  async saveSearch(input: Omit<HousingSearch, "updatedAt">) {
    const rows = await this.sql`
      insert into housing_searches (move_id, kinds, city, neighborhoods, budget_max_cents, hotel_nightly_max_cents,
        move_in, move_out, bedrooms, furnished, must_haves, notes, last_searched_at, last_search_key, shown_count)
      values (${input.moveId}, ${JSON.stringify(input.kinds)}::jsonb, ${input.city}, ${JSON.stringify(input.neighborhoods)}::jsonb,
        ${input.budgetMaxCents}, ${input.hotelNightlyMaxCents}, ${input.moveIn}, ${input.moveOut}, ${input.bedrooms},
        ${input.furnished}, ${JSON.stringify(input.mustHaves)}::jsonb, ${JSON.stringify(input.notes)}::jsonb,
        ${input.lastSearchedAt}, ${input.lastSearchKey}, ${input.shownCount})
      on conflict (move_id) do update set
        kinds = excluded.kinds, city = excluded.city, neighborhoods = excluded.neighborhoods,
        budget_max_cents = excluded.budget_max_cents, hotel_nightly_max_cents = excluded.hotel_nightly_max_cents,
        move_in = excluded.move_in, move_out = excluded.move_out, bedrooms = excluded.bedrooms,
        furnished = excluded.furnished, must_haves = excluded.must_haves, notes = excluded.notes,
        last_searched_at = excluded.last_searched_at, last_search_key = excluded.last_search_key,
        shown_count = excluded.shown_count, updated_at = now()
      returning *`;
    return searchRow(rows[0] as Row);
  }
  async listListings(moveId: string) {
    return (await this.sql`select * from listings where move_id = ${moveId} order by seq`).map(listingRow);
  }
  async upsertListing(input: Partial<Listing> & Pick<Listing, "moveId" | "site" | "kind" | "url" | "title">) {
    const prevRow = input.id
      ? (await this.sql`select * from listings where id = ${input.id}`)[0]
      : (await this.sql`select * from listings where move_id = ${input.moveId} and url = ${input.url}`)[0];
    const prev = prevRow ? listingRow(prevRow) : undefined;
    const id = prev?.id ?? input.id ?? newId("ls");
    const l: Listing = { ...listingDefaults(), ...(prev ?? {}), ...input, id };
    const rows = await this.sql`
      insert into listings (id, move_id, site, kind, url, title, price_cents, price_unit, location, available_from,
        bedrooms, snippet, posted_at, photo_count, contact, scam_flags, score, reason, rank, status, found_at)
      values (${id}, ${l.moveId}, ${l.site}, ${l.kind}, ${l.url}, ${l.title}, ${l.priceCents}, ${l.priceUnit},
        ${l.location}, ${l.availableFrom}, ${l.bedrooms}, ${l.snippet}, ${l.postedAt}, ${l.photoCount},
        ${JSON.stringify(l.contact)}::jsonb, ${JSON.stringify(l.scamFlags)}::jsonb, ${l.score}, ${l.reason},
        ${l.rank}, ${l.status}, ${l.foundAt}::timestamptz)
      on conflict (id) do update set
        move_id = excluded.move_id, site = excluded.site, kind = excluded.kind, url = excluded.url,
        title = excluded.title, price_cents = excluded.price_cents, price_unit = excluded.price_unit,
        location = excluded.location, available_from = excluded.available_from, bedrooms = excluded.bedrooms,
        snippet = excluded.snippet, posted_at = excluded.posted_at, photo_count = excluded.photo_count,
        contact = excluded.contact, scam_flags = excluded.scam_flags, score = excluded.score,
        reason = excluded.reason, rank = excluded.rank, status = excluded.status, found_at = excluded.found_at
      returning *`;
    return listingRow(rows[0] as Row);
  }

  async getThreadOwner(messageId: string) {
    const rows = await this.sql`select elf from thread_owners where message_id = ${messageId}`;
    return rows[0] ? (rows[0].elf as ElfName) : undefined;
  }
  async setThreadOwner(messageId: string, elf: ElfName) {
    await this.sql`
      insert into thread_owners (message_id, elf) values (${messageId}, ${elf})
      on conflict (message_id) do update set elf = excluded.elf`;
  }

  async getSend(key: string) {
    const rows = await this.sql`select * from sends where key = ${key}`;
    const r = rows[0];
    return r
      ? ({ key: r.key as string, messageId: str(r.message_id), createdAt: iso(r.created_at) } as SendRecord)
      : undefined;
  }
  async recordSend(key: string, messageId: string | null) {
    const rows = await this.sql`
      insert into sends (key, message_id) values (${key}, ${messageId})
      on conflict (key) do update set message_id = coalesce(excluded.message_id, sends.message_id)
      returning *`;
    const r = rows[0] as Row;
    return { key: r.key as string, messageId: str(r.message_id), createdAt: iso(r.created_at) };
  }

  async getCursor(name: string) {
    const rows = await this.sql`select value from cursors where name = ${name}`;
    return rows[0] ? (rows[0].value as string) : undefined;
  }
  async setCursor(name: string, value: string) {
    await this.sql`
      insert into cursors (name, value) values (${name}, ${value})
      on conflict (name) do update set value = excluded.value, updated_at = now()`;
  }
}
