-- The Money Elf's own state. Nessie is the record of money moved; these tables hold what Nessie cannot: who is
-- who (names and phone numbers), which Nessie customer and account each person has, the ledger entries (what a
-- movement was for, and the hand-off signals behind an escrow), the approvals waiting for the owner's yes, and
-- each move's escrow and Moving Fund accounts. All of it cascades from the move, like the rest of the store.

create table if not exists money_people (
  id                  text primary key,
  seq                 bigserial,
  move_id             text not null references moves(id) on delete cascade,
  name                text not null,
  handle              text,
  role                text not null,
  nessie_customer_id  text,
  nessie_account_id   text,
  created_at          timestamptz not null default now()
);
create index if not exists money_people_move_idx on money_people (move_id, seq);

create table if not exists money_entries (
  id                  text primary key,
  seq                 bigserial,
  move_id             text not null references moves(id) on delete cascade,
  date                text not null,
  kind                text not null,
  what                text not null,
  paid_by             text,
  owed_by             text,
  paid_to             text,
  amount_cents        bigint not null check (amount_cents > 0),
  status              text not null default 'pending',
  escrow              text,
  buyer_confirmed_at  text,
  owner_ok_at         text,
  map_converged_at    text,
  pickup_at           text,
  no_show_at          text,
  deal_id             text,
  party_id            text,
  due_back_at         text,
  group_id            text,
  requested           boolean not null default false,
  notified            boolean not null default false,
  paid_cents          bigint not null default 0,
  loan_id             text,
  loan_monthly_cents  bigint,
  flagged             boolean not null default false,
  nessie              jsonb not null default '{"withdrawalIds":[],"depositIds":[],"purchaseIds":[],"billId":null}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists money_entries_move_idx on money_entries (move_id, seq);
create index if not exists money_entries_deal_idx on money_entries (deal_id, party_id) where deal_id is not null;

create table if not exists money_pending (
  id                  text primary key,
  move_id             text not null references moves(id) on delete cascade,
  seq                 bigserial,
  kind                text not null,
  summary             text not null,
  entry_ids           jsonb not null default '[]',
  data                jsonb,
  created_at          text not null
);
create index if not exists money_pending_move_idx on money_pending (move_id, seq);

-- Nessie's GET /merchants doesn't list the ones we create, so the ids are remembered here and a restart
-- doesn't make a second "U-Haul" in Nessie for the next purchase.
create table if not exists money_merchants (
  name                text primary key,
  merchant_id         text not null,
  created_at          timestamptz not null default now()
);

create table if not exists money_accounts (
  move_id             text primary key references moves(id) on delete cascade,
  escrow_account_id   text,
  fund_account_id     text
);
