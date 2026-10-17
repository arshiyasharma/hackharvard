/**
 * @elves/shared — domain types, the Store contract and an in-memory implementation.
 * Everything else (transports, Elves, the service) depends on this and nothing here does I/O.
 */

export const ELF_NAMES = ["crew_lead", "stuff", "money", "moveday", "home"] as const;
export type ElfName = (typeof ELF_NAMES)[number];

export const ELF_LABELS: Record<ElfName, string> = {
  crew_lead: "Crew Lead",
  stuff: "Stuff Elf",
  money: "Money Elf",
  moveday: "Move-day Elf",
  home: "Home Elf",
};

export type Role = "owner" | "roommate" | "buyer" | "seller" | "applicant" | "lister";
export type ElfStatus = "idle" | "working" | "waiting" | "done" | "blocked";
export type ItemOutcome = "listed" | "sold" | "given" | "donated" | "dumped";

export interface Move {
  id: string;
  ownerHandle: string;
  ownerSpaceId: string;
  platform: string;
  name: string | null;
  moveOutAt: string | null;
  moveInAt: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  boardLinkSent: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Participant {
  id: string;
  moveId: string;
  handle: string;
  role: Role;
  spaceId: string;
  platform: string;
  /** The Photon agent user id that this participant talks to (pool number on shared iMessage). */
  agentUserId: string | null;
  createdAt: string;
}

export interface ElfStatusRow {
  moveId: string;
  elf: ElfName;
  status: ElfStatus;
  currentTask: string;
  lastUpdate: string;
  updatedAt: string;
}

export interface EventRow {
  id: string;
  moveId: string | null;
  type: string;
  payload: Record<string, unknown>;
  traceId: string | null;
  createdAt: string;
}

export interface Item {
  id: string;
  moveId: string;
  name: string;
  category: string;
  weightLb: number;
  /** Listing copy and pricing, filled by intake from a photo. */
  title: string | null;
  description: string | null;
  condition: string | null;
  priceLowCents: number | null;
  priceHighCents: number | null;
  listPriceCents: number | null;
  floorPriceCents: number | null;
  photoAttachmentIds: string[];
  /** Owner said "list it" (or equivalent) after seeing the price. */
  listingApproved: boolean;
  outcome: ItemOutcome;
  createdAt: string;
}

export interface SendRecord {
  key: string;
  messageId: string | null;
  createdAt: string;
}

// ---- housing search (Home Elf) ----

export const LISTING_KINDS = ["room", "sublet", "apartment", "hotel", "storage"] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];
export type ListingStatus = "found" | "shortlisted" | "contacted" | "rejected";
export type PriceUnit = "month" | "night";

/** What one site search asks for; derived from a HousingSearch, one per kind. */
export interface ListingQuery {
  kind: ListingKind;
  /** "Boston, MA" */
  city: string;
  neighborhoods: string[];
  budgetMaxCents: number | null;
  /** month for housing and storage, night for hotels */
  priceUnit: PriceUnit;
  /** ISO date; for a hotel, the first night */
  moveIn: string | null;
  /** ISO date; for a hotel, the checkout */
  moveOut: string | null;
  bedrooms: number | null;
  furnished: boolean | null;
  mustHaves: string[];
}

/** The owner's saved housing requirements for this move (one per move). */
export interface HousingSearch {
  moveId: string;
  kinds: ListingKind[];
  city: string | null;
  neighborhoods: string[];
  budgetMaxCents: number | null;
  hotelNightlyMaxCents: number | null;
  moveIn: string | null;
  moveOut: string | null;
  bedrooms: number | null;
  furnished: boolean | null;
  mustHaves: string[];
  /** Owner phrasing that fits no field ("no basements"). */
  notes: string[];
  lastSearchedAt: string | null;
  /** Hash of the queries that last ran, for the short idempotency window. */
  lastSearchKey: string | null;
  /** How many ranked picks have been texted; "more" continues from here. */
  shownCount: number;
  updatedAt: string;
}

export interface ListingContact {
  phone: string | null;
  email: string | null;
  /** In-platform message link (Facebook item page, Airbnb contact host) for the outreach phase. */
  messageUrl: string | null;
}

/** One listing as a site returned it, validated and price-normalized. */
export interface SiteResult {
  site: string;
  kind: ListingKind;
  url: string;
  title: string;
  priceCents: number | null;
  priceUnit: PriceUnit;
  location: string | null;
  availableFrom: string | null;
  bedrooms: number | null;
  snippet: string | null;
  postedAt: string | null;
  /** Number of photos the listing shows, when the site says; null when unknown. */
  photoCount: number | null;
  contact: ListingContact;
}

/** A SiteResult the crew keeps: ranked, flagged, with a status the owner can change. */
export interface Listing extends SiteResult {
  id: string;
  moveId: string;
  scamFlags: string[];
  /** 0-100 after ranking */
  score: number;
  reason: string;
  /** 1-based position in the last ranking; "tell me about 2" resolves on this. */
  rank: number | null;
  status: ListingStatus;
  foundAt: string;
  createdAt: string;
}

// ---- deals (Deal Engine) ----

/** One engine, four modes: what is on the table and which way a good price points. */
export const DEAL_MODES = ["sell_item", "buy_item", "sublet_out", "find_sublet"] as const;
export type DealMode = (typeof DEAL_MODES)[number];
/** listed → negotiating → scheduled → handed_off → paid | relisted | donated | dumped */
export const DEAL_STATES = [
  "listed",
  "negotiating",
  "scheduled",
  "handed_off",
  "paid",
  "relisted",
  "donated",
  "dumped",
] as const;
export type DealState = (typeof DEAL_STATES)[number];
export type DealPartyStatus =
  | "talking"
  | "awaiting_owner"
  | "agreed"
  | "scheduled"
  | "handed_off"
  | "waitlisted"
  | "walked"
  | "blocked";

/** One pickup (or viewing, or key hand-off) slot on the move's shared calendar. */
export interface Slot {
  /** Stable id: the slot's start instant, so the same hour offered twice is the same slot. */
  id: string;
  start: string;
  end: string;
  /** "Sat 10am", in the move's time zone. */
  label: string;
}

export interface Deal {
  id: string;
  moveId: string;
  mode: DealMode;
  /** The item (sell/buy) or listing (sublets) this deal is about; null for a free-standing search. */
  subjectId: string | null;
  title: string;
  /** Short public reference a counterparty quotes in their first text ("K7Q2"); unique across moves. */
  code: string;
  state: DealState;
  /** Our standing price: the list price we sell at, or the opening offer we buy at. */
  askCents: number | null;
  /** The owner's line: floor when selling or renting out, ceiling when buying or renting. Never told to a counterparty. */
  limitCents: number | null;
  unit: "each" | "month";
  /** The owner-chat message every summary for this deal threads under. */
  ownerThreadId: string | null;
  winnerPartyId: string | null;
  agreedCents: number | null;
  slot: Slot | null;
  /** Set once the deal exits; the Move Report counts these. */
  outcome: ItemOutcome | null;
  /**
   * Last Call progress for modes that relist before move-out. `dropped` is the T−48h price,
   * `free` is T−24h, `closed` is the donation or 311 booking at move-out.
   */
  lastCallStage: "none" | "dropped" | "free" | "closed";
  /** The owner said to hold this one ("keep the couch"); Last Call leaves it alone. */
  lastCallOptOut: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One counterparty in one deal, talking in their own space. */
export interface DealParty {
  id: string;
  dealId: string;
  moveId: string;
  spaceId: string;
  handle: string;
  role: Role;
  status: DealPartyStatus;
  lastOfferCents: number | null;
  lastCounterCents: number | null;
  agreedCents: number | null;
  rounds: number;
  offeredSlots: Slot[];
  slot: Slot | null;
  /** The owner-chat question about this party's offer, so a threaded "yes" finds it. */
  ownerAskMessageId: string | null;
  /** The price the owner allowed for this party, past the deal's limit. */
  ownerApprovedCents: number | null;
  scamFlags: string[];
  noShows: number;
  createdAt: string;
  updatedAt: string;
}

/** Column defaults for a deal row, shared by every Store implementation. */
export function dealDefaults(): Omit<Deal, "id" | "moveId" | "mode" | "title" | "code"> {
  const ts = nowIso();
  return {
    subjectId: null,
    state: "listed",
    askCents: null,
    limitCents: null,
    unit: "each",
    ownerThreadId: null,
    winnerPartyId: null,
    agreedCents: null,
    slot: null,
    outcome: null,
    lastCallStage: "none",
    lastCallOptOut: false,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function dealPartyDefaults(): Omit<
  DealParty,
  "id" | "dealId" | "moveId" | "spaceId" | "handle" | "role"
> {
  const ts = nowIso();
  return {
    status: "talking",
    lastOfferCents: null,
    lastCounterCents: null,
    agreedCents: null,
    rounds: 0,
    offeredSlots: [],
    slot: null,
    ownerAskMessageId: null,
    ownerApprovedCents: null,
    scamFlags: [],
    noShows: 0,
    createdAt: ts,
    updatedAt: ts,
  };
}

export const OPEN_DEAL_STATES: readonly DealState[] = ["listed", "negotiating", "scheduled", "relisted"];

export interface Store {
  getMove(id: string): Promise<Move | undefined>;
  getMoveBySpace(spaceId: string): Promise<Move | undefined>;
  getMoveByOwnerHandle(handle: string): Promise<Move | undefined>;
  listMoves(): Promise<Move[]>;
  createMove(input: Pick<Move, "ownerHandle" | "ownerSpaceId" | "platform"> & { id?: string }): Promise<Move>;
  updateMove(id: string, patch: Partial<Omit<Move, "id" | "createdAt">>): Promise<Move>;

  upsertParticipant(input: Omit<Participant, "id" | "createdAt">): Promise<Participant>;
  getParticipantBySpace(spaceId: string): Promise<Participant | undefined>;
  listParticipants(moveId: string): Promise<Participant[]>;

  getBoard(moveId: string): Promise<ElfStatusRow[]>;
  patchBoard(
    moveId: string,
    elf: ElfName,
    patch: Partial<Omit<ElfStatusRow, "moveId" | "elf" | "updatedAt">>,
  ): Promise<ElfStatusRow>;

  appendEvent(input: Omit<EventRow, "id" | "createdAt">): Promise<EventRow>;
  listEvents(moveId: string): Promise<EventRow[]>;

  listItems(moveId: string): Promise<Item[]>;
  upsertItem(input: Partial<Item> & Pick<Item, "moveId" | "name" | "category">): Promise<Item>;

  getSearch(moveId: string): Promise<HousingSearch | undefined>;
  /** Full replace of the move's housing requirements. */
  saveSearch(input: Omit<HousingSearch, "updatedAt">): Promise<HousingSearch>;
  /** Every listing kept for the move, in the order found. */
  listListings(moveId: string): Promise<Listing[]>;
  /** Matches by id, else by (moveId, url); a re-found listing keeps its status unless the input sets it. */
  upsertListing(
    input: Partial<Listing> & Pick<Listing, "moveId" | "site" | "kind" | "url" | "title">,
  ): Promise<Listing>;

  listDeals(moveId: string): Promise<Deal[]>;
  getDeal(id: string): Promise<Deal | undefined>;
  getDealByCode(code: string): Promise<Deal | undefined>;
  /** Every deal still on the table (listed, negotiating, scheduled, relisted), across moves. */
  listOpenDeals(): Promise<Deal[]>;
  /** Matches by id; a new deal needs a unique code. */
  upsertDeal(input: Partial<Deal> & Pick<Deal, "moveId" | "mode" | "title" | "code">): Promise<Deal>;
  listDealParties(dealId: string): Promise<DealParty[]>;
  /** Every deal this space's counterparty is in, oldest first. */
  listDealPartiesBySpace(spaceId: string): Promise<DealParty[]>;
  /** Matches by id, else by (dealId, spaceId). */
  upsertDealParty(
    input: Partial<DealParty> & Pick<DealParty, "dealId" | "moveId" | "spaceId" | "handle" | "role">,
  ): Promise<DealParty>;

  getThreadOwner(messageId: string): Promise<ElfName | undefined>;
  setThreadOwner(messageId: string, elf: ElfName): Promise<void>;

  getSend(key: string): Promise<SendRecord | undefined>;
  recordSend(key: string, messageId: string | null): Promise<SendRecord>;

  getCursor(name: string): Promise<string | undefined>;
  setCursor(name: string, value: string): Promise<void>;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Column defaults for a listing row, shared by every Store implementation. */
export function listingDefaults(): Omit<Listing, "id" | "moveId" | "site" | "kind" | "url" | "title"> {
  const ts = nowIso();
  return {
    priceCents: null,
    priceUnit: "month",
    location: null,
    availableFrom: null,
    bedrooms: null,
    snippet: null,
    postedAt: null,
    photoCount: null,
    contact: { phone: null, email: null, messageUrl: null },
    scamFlags: [],
    score: 0,
    reason: "",
    rank: null,
    status: "found",
    foundAt: ts,
    createdAt: ts,
  };
}

export class MemoryStore implements Store {
  moves = new Map<string, Move>();
  participants = new Map<string, Participant>();
  board = new Map<string, ElfStatusRow>();
  events: EventRow[] = [];
  items = new Map<string, Item>();
  searches = new Map<string, HousingSearch>();
  listings = new Map<string, Listing>();
  deals = new Map<string, Deal>();
  dealParties = new Map<string, DealParty>();
  threads = new Map<string, ElfName>();
  sends = new Map<string, SendRecord>();
  cursors = new Map<string, string>();

  async getMove(id: string) {
    return this.moves.get(id);
  }
  async getMoveBySpace(spaceId: string) {
    for (const m of this.moves.values()) if (m.ownerSpaceId === spaceId) return m;
    const p = await this.getParticipantBySpace(spaceId);
    return p ? this.moves.get(p.moveId) : undefined;
  }
  async getMoveByOwnerHandle(handle: string) {
    for (const m of this.moves.values()) if (m.ownerHandle === handle) return m;
    return undefined;
  }
  async listMoves() {
    return [...this.moves.values()];
  }
  async createMove(input: Pick<Move, "ownerHandle" | "ownerSpaceId" | "platform"> & { id?: string }) {
    const ts = nowIso();
    const { id, ...rest } = input;
    const move: Move = {
      id: id ?? newId("mv"),
      name: null,
      moveOutAt: null,
      moveInAt: null,
      fromAddress: null,
      toAddress: null,
      boardLinkSent: false,
      createdAt: ts,
      updatedAt: ts,
      ...rest,
    };
    this.moves.set(move.id, move);
    for (const elf of ELF_NAMES) {
      this.board.set(`${move.id}:${elf}`, {
        moveId: move.id,
        elf,
        status: elf === "crew_lead" ? "working" : "idle",
        currentTask: elf === "crew_lead" ? "Getting the move set up" : "Standing by",
        lastUpdate: "",
        updatedAt: ts,
      });
    }
    return move;
  }
  async updateMove(id: string, patch: Partial<Omit<Move, "id" | "createdAt">>) {
    const m = this.moves.get(id);
    if (!m) throw new Error(`move ${id} not found`);
    const next = { ...m, ...patch, updatedAt: nowIso() };
    this.moves.set(id, next);
    return next;
  }

  async upsertParticipant(input: Omit<Participant, "id" | "createdAt">) {
    const existing = this.participants.get(input.spaceId);
    if (existing) {
      const next = { ...existing, ...input };
      this.participants.set(input.spaceId, next);
      return next;
    }
    const p: Participant = { id: newId("pt"), createdAt: nowIso(), ...input };
    this.participants.set(p.spaceId, p);
    return p;
  }
  async getParticipantBySpace(spaceId: string) {
    return this.participants.get(spaceId);
  }
  async listParticipants(moveId: string) {
    return [...this.participants.values()].filter((p) => p.moveId === moveId);
  }

  async getBoard(moveId: string) {
    return ELF_NAMES.map((elf) => this.board.get(`${moveId}:${elf}`)).filter((r): r is ElfStatusRow => !!r);
  }
  async patchBoard(
    moveId: string,
    elf: ElfName,
    patch: Partial<Omit<ElfStatusRow, "moveId" | "elf" | "updatedAt">>,
  ) {
    const key = `${moveId}:${elf}`;
    const row: ElfStatusRow = this.board.get(key) ?? {
      moveId,
      elf,
      status: "idle",
      currentTask: "",
      lastUpdate: "",
      updatedAt: nowIso(),
    };
    const next = { ...row, ...patch, updatedAt: nowIso() };
    this.board.set(key, next);
    return next;
  }

  async appendEvent(input: Omit<EventRow, "id" | "createdAt">) {
    const ev: EventRow = { id: newId("ev"), createdAt: nowIso(), ...input };
    this.events.push(ev);
    return ev;
  }
  async listEvents(moveId: string) {
    return this.events.filter((e) => e.moveId === moveId);
  }

  async listItems(moveId: string) {
    return [...this.items.values()].filter((i) => i.moveId === moveId);
  }
  async upsertItem(input: Partial<Item> & Pick<Item, "moveId" | "name" | "category">) {
    const id = input.id ?? newId("it");
    const prev = this.items.get(id);
    const item: Item = {
      weightLb: 25,
      title: null,
      description: null,
      condition: null,
      priceLowCents: null,
      priceHighCents: null,
      listPriceCents: null,
      floorPriceCents: null,
      photoAttachmentIds: [],
      listingApproved: false,
      outcome: "listed",
      createdAt: nowIso(),
      ...(prev ?? {}),
      ...input,
      id,
    };
    this.items.set(id, item);
    return item;
  }

  async getSearch(moveId: string) {
    return this.searches.get(moveId);
  }
  async saveSearch(input: Omit<HousingSearch, "updatedAt">) {
    const search: HousingSearch = { ...input, updatedAt: nowIso() };
    this.searches.set(input.moveId, search);
    return search;
  }
  async listListings(moveId: string) {
    return [...this.listings.values()].filter((l) => l.moveId === moveId);
  }
  async upsertListing(input: Partial<Listing> & Pick<Listing, "moveId" | "site" | "kind" | "url" | "title">) {
    const prev = input.id
      ? this.listings.get(input.id)
      : [...this.listings.values()].find((l) => l.moveId === input.moveId && l.url === input.url);
    const id = prev?.id ?? input.id ?? newId("ls");
    const listing: Listing = { ...listingDefaults(), ...(prev ?? {}), ...input, id };
    this.listings.set(id, listing);
    return listing;
  }

  async listDeals(moveId: string) {
    return [...this.deals.values()].filter((d) => d.moveId === moveId);
  }
  async getDeal(id: string) {
    return this.deals.get(id);
  }
  async getDealByCode(code: string) {
    const c = code.toUpperCase();
    for (const d of this.deals.values()) if (d.code === c) return d;
    return undefined;
  }
  async listOpenDeals() {
    return [...this.deals.values()].filter((d) => OPEN_DEAL_STATES.includes(d.state));
  }
  async upsertDeal(input: Partial<Deal> & Pick<Deal, "moveId" | "mode" | "title" | "code">) {
    const prev = input.id ? this.deals.get(input.id) : undefined;
    const code = input.code.toUpperCase();
    for (const d of this.deals.values())
      if (d.code === code && d.id !== prev?.id) throw new Error(`deal code ${code} is taken`);
    const id = prev?.id ?? input.id ?? newId("dl");
    const deal: Deal = { ...dealDefaults(), ...(prev ?? {}), ...input, code, id, updatedAt: nowIso() };
    if (prev) deal.createdAt = prev.createdAt;
    this.deals.set(id, deal);
    return deal;
  }
  async listDealParties(dealId: string) {
    return [...this.dealParties.values()].filter((p) => p.dealId === dealId);
  }
  async listDealPartiesBySpace(spaceId: string) {
    return [...this.dealParties.values()].filter((p) => p.spaceId === spaceId);
  }
  async upsertDealParty(
    input: Partial<DealParty> & Pick<DealParty, "dealId" | "moveId" | "spaceId" | "handle" | "role">,
  ) {
    const prev = input.id
      ? this.dealParties.get(input.id)
      : [...this.dealParties.values()].find((p) => p.dealId === input.dealId && p.spaceId === input.spaceId);
    const id = prev?.id ?? input.id ?? newId("dp");
    const party: DealParty = { ...dealPartyDefaults(), ...(prev ?? {}), ...input, id, updatedAt: nowIso() };
    if (prev) party.createdAt = prev.createdAt;
    this.dealParties.set(id, party);
    return party;
  }

  async getThreadOwner(messageId: string) {
    return this.threads.get(messageId);
  }
  async setThreadOwner(messageId: string, elf: ElfName) {
    this.threads.set(messageId, elf);
  }

  async getSend(key: string) {
    return this.sends.get(key);
  }
  async recordSend(key: string, messageId: string | null) {
    const prev = this.sends.get(key);
    const rec: SendRecord = {
      key,
      messageId: messageId ?? prev?.messageId ?? null,
      createdAt: prev?.createdAt ?? nowIso(),
    };
    this.sends.set(key, rec);
    return rec;
  }

  async getCursor(name: string) {
    return this.cursors.get(name);
  }
  async setCursor(name: string, value: string) {
    this.cursors.set(name, value);
  }
}

/** Tiny structured logger; LOG_LEVEL=debug|info|warn|error. */
export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export function createLogger(scope: string, level: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info") {
  const min = LEVELS[level] ?? 20;
  const emit = (lvl: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const line = { t: nowIso(), lvl, scope, msg, ...(data ?? {}) };
    const out = lvl === "error" || lvl === "warn" ? console.error : console.log;
    out(JSON.stringify(line));
  };
  return {
    debug: (m: string, d?: Record<string, unknown>) => emit("debug", m, d),
    info: (m: string, d?: Record<string, unknown>) => emit("info", m, d),
    warn: (m: string, d?: Record<string, unknown>) => emit("warn", m, d),
    error: (m: string, d?: Record<string, unknown>) => emit("error", m, d),
  };
}
export type Logger = ReturnType<typeof createLogger>;
