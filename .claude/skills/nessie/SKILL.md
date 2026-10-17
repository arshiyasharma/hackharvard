---
name: nessie
description: How to call Capital One's Nessie API (the simulated bank behind the Money Elf), including the quirks verified live that its published docs get wrong, plus how to inspect what the Money Elf wrote there. Use when writing or debugging code that calls Nessie, when probing a new Nessie endpoint, or when checking records in the team's Nessie sandbox.
---

# Nessie (simulated bank)

Docs: https://nessieisreal.com/docs. OpenAPI spec: https://nessieisreal.com/nessie-openapi-spec.yaml. Base URL: `https://prod-api.nessieisreal.com` (a QA host exists at `qa-api.`). Auth is a `?key=$NESSIE_API_KEY` query parameter on every request. The key is in `.env`; never print it, log it or put it in a URL you show the user.

## Verified behavior (Oct 17 2026), which beats the docs

- Create calls return `{"code":201,"message":"...","objectCreated":{"_id":"<uuid>",...}}`. The spec says only a string comes back; it's wrong.
- **Balances never change.** Withdrawals and deposits are stored, but `account.balance` stays put, and overdrafts are accepted. The Money Elf's Ledger is the source of truth for balances; Nessie is the audit trail.
- **Transfers can't name a payee.** `POST /accounts/{id}/transfers` accepts only `transaction_date, status, amount, description`. A movement from A to B is a withdrawal on A plus a deposit on B (`NessiePayments.moveMoney`).
- Withdrawal/deposit body: `{medium:"balance", amount:<int cents>, status:"completed", transaction_date:"YYYY-MM-DD", description}`. `status` is one of pending, cancelled, completed.
- Bills: always send `recurring_date` (1–31). Without it, `GET /accounts/{id}/bills` and `GET /bills/{id}` fail validation. Update with `PUT /bills/{id} {"status":"completed"}`.
- Unknown fields are rejected ("extra fields not permitted"). That makes probing cheap: POST `{"<field>":"x"}`, and the error lists the missing required fields and rejects the bad ones, without creating anything.
- There is no customer DELETE, so sandbox data piles up. Name test data clearly (for example "Smoke Owner").
- Amounts are integers, and the team stores **cents** (decision #7).

## Probing safely

1. Read-only first: `GET /customers`, `GET /accounts/{id}`, `GET /accounts/{id}/withdrawals|deposits|bills`.
2. To discover a body shape, POST an empty or one-field body and read the validation error.
3. Create real records only in the sandbox, with obvious test names, and tell the user you're doing it.
4. When a probe changes what we know, update the "Verified behavior" list above and log it with the `record-decision` skill.

## Inspecting Money Elf records

`bun run packages/money-elf/scripts/smoke.ts` prints the account ids it created. Then:
```bash
K=$(grep -E '^NESSIE_API_KEY=' .env | cut -d= -f2- | tr -d '"'); curl -sS "https://prod-api.nessieisreal.com/accounts/<id>/withdrawals?key=$K"
```
The code lives in `packages/money-elf/src/payments.ts`: `NessiePayments` for real calls, `FakePayments` for tests.
