import { MemoryMoneyStore } from "../src/ledger.ts";
import { createMoneyElf } from "../src/money-elf.ts";
import { FakePayments } from "../src/payments.ts";
import type { MoneyContext, MoneyLLM, MoneyResult, Role } from "../src/types.ts";

export const OWNER = "+16175550100";
export const NOW = new Date("2026-10-17T15:00:00Z");

export const fakeLLM: MoneyLLM = {
  name: "fake",
  async extract() {
    throw new Error("fake llm");
  },
};

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

export function setup() {
  const store = new MemoryMoneyStore();
  const payments = new FakePayments();
  const elf = createMoneyElf({ store, payments, now: () => NOW });
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
  return { store, payments, elf, move, say };
}

export function reply(r: MoneyResult): string {
  return r.replies.map((x) => x.text).join("\n");
}

export function eventTypes(r: MoneyResult): string[] {
  return (r.events ?? []).map((e) => e.type);
}
