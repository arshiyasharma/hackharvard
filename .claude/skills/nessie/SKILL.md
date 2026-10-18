---
name: nessie
description: How to call Capital One's Nessie API (the simulated bank behind the Money Elf), including the quirks verified live that its published docs get wrong, plus how to inspect what the Money Elf wrote there. Use when writing or debugging code that calls Nessie, when probing a new Nessie endpoint, or when checking records in the team's Nessie sandbox.
---

# Nessie (simulated bank)

Docs: https://nessieisreal.com/docs. OpenAPI spec: https://nessieisreal.com/nessie-openapi-spec.yaml. Base URL: `https://prod-api.nessieisreal.com` (a QA host exists at `qa-api.`). Auth is a `?key=$NESSIE_API_KEY` query parameter on every request. The key is in `.env`; never print it, log it or put it in a URL you show the user.

## Verified behavior (Oct 17 2026), which beats the docs

- Create calls return `{"code":201,"message":"...","objectCreated":{"_id":"<uuid>",...}}`. The spec says only a string comes back; it's wrong.
- **Balances never change.** Withdrawals and deposits are stored, but `account.balance` stays put, and overdrafts are accepted. The Money Elf's Ledger is the source of truth for balances; Nessie is the audit trail.
- **Transfers can't name a payee.** (re-checked Oct 17 2026: `payee_id` and `medium` are rejected) `POST /accounts/{id}/transfers` accepts only `transaction_date, status, amount, description`. A movement from A to B is a withdrawal on A plus a deposit on B (`NessieRails.moveMoney`).
- Withdrawal/deposit body: `{medium:"balance", amount:<int cents>, status:"completed", transaction_date:"YYYY-MM-DD", description}`. `status` is one of pending, cancelled, completed.
- Bills: always send `recurring_date` (1–31). Without it, `GET /accounts/{id}/bills` and `GET /bills/{id}` fail validation. Update with `PUT /bills/{id} {"status":"completed"}`.
- Unknown fields are rejected ("extra fields not permitted"). That makes probing cheap: POST `{"<field>":"x"}`, and the error lists the missing required fields and rejects the bad ones, without creating anything.
- There is no customer DELETE, so sandbox data piles up. Name test data clearly (for example "Smoke Owner").
- Amounts are integers, and the team stores **cents** (decision #7).
- Loans: `POST /accounts/{id}/loans` takes `{type, status, credit_score, monthly_payment, amount, description}`. `type` and `status` are free text. `PUT /loans/{id}` updates `amount` and `status`, so we lower `amount` to what's left after each payment.
- `POST /customers/{id}/accounts` opens a second account (for example a second `type: "Checking"`) on an existing customer. That's how the Moving Fund (a second Checking account) works; Escrow is a Savings account on its own customer.
- An empty list can come back as **404 with a message string** ("No transfers found for this account"). Treat it as `[]` (`NessieRails.list`).
- **Purchases** (`POST /accounts/{id}/purchases`): `{merchant_id, medium:"balance", amount, status, purchase_date, description}`. Always send `status` and `purchase_date`: without them the purchase is stored, then `GET /accounts/{id}/purchases` fails validation for that account for good. `merchant_id` isn't checked (a made-up id is accepted). Purchases don't change balances either. An empty purchase list is `200 []`, and `GET /purchases/{id}` isn't routed. The Money Elf posts truck, storage and movers this way (`NessieRails.purchase`).
- **Merchants** (`POST /merchants`): `{name, category}`, with `category` a string; unknown fields are silently dropped here, unlike elsewhere. `GET /merchants` didn't list merchants we created, so `NessieRails` caches merchant ids by name per process.
- **Pending, future-dated records work (verified Oct 18 2026).** Deposits and withdrawals accept `status:"pending"` with a future `transaction_date`. `PUT /deposits/{id}` and `PUT /withdrawal/{id}` (singular) with `{"status":"completed"|"cancelled"}` return 202 and stick. Purchases accept pending and a future `purchase_date`, but `PUT /purchase/{id}` rejects `status`, so a purchase can't be settled later. Move Plans uses pending withdrawals for expected costs (decision #54).
- ATMs and branches return Capital One locations, but the `lat/lng/rad` filter seemed to be ignored (a Cambridge query returned Arlington, VA). Enterprise list endpoints timed out once.

## How the Money Elf uses Nessie as its ledger

Every movement's description ends in a tag, `[elves:<kind>:<ledgerEntryId>]` (decision #27). `src/books.ts` reads the owner's checking account, the Moving Fund (a second Checking account), Escrow (Savings) and each person's account, then rebuilds the totals from the tagged records, open bills and open loans. Run `/books` in `scripts/chat.ts` to see it account by account.

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
The code lives in `packages/money-elf/src/rails.ts` behind the `MoneyRails` interface: `NessieRails` for real calls, `FakeRails` for tests.
