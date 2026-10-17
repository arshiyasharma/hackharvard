/**
 * @elves/shared — domain types, the Store contract and an in-memory implementation.
 * Everything else (transports, Elves, the service) depends on this and nothing here does I/O.
 */

export const ELF_NAMES = [
  "crew_lead",
  "sell",
  "buy",
  "green",
  "money",
  "haul",
  "map",
  "lease",
  "hunt",
  "movein",
] as const;
export type ElfName = (typeof ELF_NAMES)[number];

export const ELF_LABELS: Record<ElfName, string> = {
  crew_lead: "Crew Lead",
  sell: "Sell Elf",
  buy: "Buy Elf",
  green: "Green Elf",
  money: "Money Elf",
  haul: "Haul Elf",
  map: "Map Elf",
  lease: "Lease Elf",
  hunt: "Hunt Elf",
  movein: "Move-in Elf",
};

export type Role = "owner" | "roommate" | "buyer" | "applicant" | "lister";
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

export interface Store {
  getMove(id: string): Promise<Move | undefined>;
  getMoveBySpace(spaceId: string): Promise<Move | undefined>;
  getMoveByOwnerHandle(handle: string): Promise<Move | undefined>;
  listMoves(): Promise<Move[]>;
  createMove(input: Pick<Move, "ownerHandle" | "ownerSpaceId" | "platform">): Promise<Move>;
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

export class MemoryStore implements Store {
  moves = new Map<string, Move>();
  participants = new Map<string, Participant>();
  board = new Map<string, ElfStatusRow>();
  events: EventRow[] = [];
  items = new Map<string, Item>();
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
  async createMove(input: Pick<Move, "ownerHandle" | "ownerSpaceId" | "platform">) {
    const ts = nowIso();
    const move: Move = {
      id: newId("mv"),
      name: null,
      moveOutAt: null,
      moveInAt: null,
      fromAddress: null,
      toAddress: null,
      boardLinkSent: false,
      createdAt: ts,
      updatedAt: ts,
      ...input,
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
    const rec: SendRecord = { key, messageId, createdAt: nowIso() };
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
