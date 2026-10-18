-- Move Plans (the Money Elf's predictive layer): each move's latest three drafts, the chosen plan, the Nessie
-- records written for it and the daily real-cost points drawn over its path, as one document per move. Drafts
-- never go to Nessie, so this is the only copy; it cascades from the move like the rest of the Money state.

create table if not exists money_plans (
  move_id     text primary key references moves(id) on delete cascade,
  state       jsonb not null,
  updated_at  timestamptz not null default now()
);
