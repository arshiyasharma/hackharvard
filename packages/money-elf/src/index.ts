export * from "./amounts.ts";
export * from "./books.ts";
export * from "./ledger.ts";
export * from "./ledger-card.ts";
export * from "./ledger-http.ts";
export * from "./ledger-page.ts";
export * from "./ledger-view.ts";
export * from "./money-elf.ts";
export * from "./parse.ts";
export * from "./payments.ts";
export * from "./scam.ts";
export * from "./service.ts";
export * from "./types.ts";

import { MemoryMoneyStore } from "./ledger.ts";
import { createMoneyElf } from "./money-elf.ts";
import { FakePayments, NessiePayments, type PaymentsProvider } from "./payments.ts";

/** Nessie when NESSIE_API_KEY is set, otherwise the in-memory fake (tests, offline demo). */
export function paymentsFromEnv(env: Record<string, string | undefined> = process.env): PaymentsProvider {
  const apiKey = env.NESSIE_API_KEY;
  return apiKey ? new NessiePayments({ apiKey, baseUrl: env.NESSIE_BASE_URL }) : new FakePayments();
}

/**
 * A ready Money Elf for the service: in-memory Ledger (like the rest of the store today), payments from env,
 * and live Ledger links when PUBLIC_URL and LEDGER_LINK_SECRET are both set.
 */
export function moneyElfFromEnv(env: Record<string, string | undefined> = process.env) {
  const publicUrl = env.PUBLIC_URL;
  const secret = env.LEDGER_LINK_SECRET;
  return createMoneyElf({
    store: new MemoryMoneyStore(),
    payments: paymentsFromEnv(env),
    links: publicUrl && secret ? { publicUrl, secret } : undefined,
  });
}
