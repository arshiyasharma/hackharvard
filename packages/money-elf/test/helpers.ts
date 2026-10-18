import { createDb, migrate } from "@elves/db";
import { createLogger } from "@elves/shared";
import { type LedgerEntry, MemoryMoneyStore, type MoneyStore, type PendingAction, type Person, type PlanState } from "../src/ledger.ts";
import { PostgresMoneyStore } from "../src/pg-store.ts";
import { createMoneyElf } from "../src/money-elf.ts";
import { FakeRails } from "../src/rails.ts";
import type { MoneyContext, MoneyLLM, MoneyResult, Role } from "../src/types.ts";

export const OWNER = "+16175550100";
export const NOW = new Date("2026-10-17T15:00:00Z");

export const fakeLLM: MoneyLLM = {
  name: "fake",
  async extract() {
    throw new Error("fake llm");
  },
};

const quietLog = {
  debug() {},
  info() {},
  warn() {},
  error(m: string, d?: Record<string, unknown>) {
    if (process.env.MONEY_TEST_DEBUG) console.error(m, d);
  },
};

/**
 * The store every Money test builds on. Memory by default; with TEST_DATABASE_URL and MONEY_TEST_PG=1 the very
 * same tests run against Postgres (`bun run test:money-pg`), which is how the Elf's own state is proven seamless.
 * A test's move ("mv_test") is created in the database on first use and wiped first, so tests don't leak into
 * each other; files run one after another.
 */
const pgUrl = process.env.MONEY_TEST_PG === "1" ? process.env.TEST_DATABASE_URL : undefined;
const db = pgUrl ? createDb({ url: pgUrl, max: 3 }) : null;
if (db) await migrate(db, createLogger("test", "error")); // the pool lives for the whole run; bun test exits when done

class TestPgStore extends PostgresMoneyStore {
  private readonly ready = new Set<string>();
  constructor(private readonly pool: NonNullable<typeof db>) {
    super(pool);
  }
  private async ensure(moveId: string) {
    if (this.ready.has(moveId)) return;
    this.ready.add(moveId);
    await this.pool`delete from moves where id = ${moveId}`;
    await this.pool`
      insert into moves (id, owner_handle, owner_space_id, platform)
      values (${moveId}, ${`${moveId}:${crypto.randomUUID()}`}, 'sp_test', 'script')`;
  }
  override async listEntries(moveId: string) {
    await this.ensure(moveId);
    return super.listEntries(moveId);
  }
  override async addEntry(input: Parameters<PostgresMoneyStore["addEntry"]>[0]): Promise<LedgerEntry> {
    await this.ensure(input.moveId);
    return super.addEntry(input);
  }
  override async listPeople(moveId: string): Promise<Person[]> {
    await this.ensure(moveId);
    return super.listPeople(moveId);
  }
  override async upsertPerson(input: Parameters<PostgresMoneyStore["upsertPerson"]>[0]): Promise<Person> {
    await this.ensure(input.moveId);
    return super.upsertPerson(input);
  }
  override async listPending(moveId: string): Promise<PendingAction[]> {
    await this.ensure(moveId);
    return super.listPending(moveId);
  }
  override async addPending(input: Parameters<PostgresMoneyStore["addPending"]>[0]): Promise<PendingAction> {
    await this.ensure(input.moveId);
    return super.addPending(input);
  }
  override async getEscrowAccount(moveId: string) {
    await this.ensure(moveId);
    return super.getEscrowAccount(moveId);
  }
  override async setEscrowAccount(moveId: string, accountId: string) {
    await this.ensure(moveId);
    return super.setEscrowAccount(moveId, accountId);
  }
  override async getFundAccount(moveId: string) {
    await this.ensure(moveId);
    return super.getFundAccount(moveId);
  }
  override async setFundAccount(moveId: string, accountId: string) {
    await this.ensure(moveId);
    return super.setFundAccount(moveId, accountId);
  }
  override async getPlans(moveId: string) {
    await this.ensure(moveId);
    return super.getPlans(moveId);
  }
  override async setPlans(moveId: string, state: PlanState | null) {
    await this.ensure(moveId);
    return super.setPlans(moveId, state);
  }
}

export function testStore(): MoneyStore {
  return db ? new TestPgStore(db) : new MemoryMoneyStore();
}

export function setup() {
  const store = testStore();
  const rails = new FakeRails();
  const elf = createMoneyElf({ store, rails, now: () => NOW });
  const move = { id: "mv_test", ownerHandle: OWNER, name: "Gavin" };
  let n = 0;
  async function say(
    text: string,
    opts: { from?: string; role?: Role; llm?: MoneyLLM } = {},
  ): Promise<MoneyResult> {
    const id = `msg_${++n}`;
    const ctx: MoneyContext = {
      llm: opts.llm ?? fakeLLM,
      move,
      participant: { handle: opts.from ?? OWNER, role: opts.role ?? "owner" },
      batch: { spaceId: "sp_1", traceId: `tr_${n}`, messages: [{ id, text }] },
      traceId: `tr_${n}`,
      log: quietLog,
      now: () => NOW,
    };
    return elf.handle(ctx);
  }
  return { store, rails, elf, move, say };
}

export function reply(r: MoneyResult): string {
  return r.replies.map((x) => x.text).join("\n");
}

export function eventTypes(r: MoneyResult): string[] {
  return (r.events ?? []).map((e) => e.type);
}
