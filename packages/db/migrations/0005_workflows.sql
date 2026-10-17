-- Deal Engine (Mastra Workflows) index tables. Workflow position lives in mastra_workflow_snapshot; these rows are
-- the queryable state per item, buyer space and move, and what the Crew Board shows.

create table if not exists deal_runs (
  id                  text primary key,
  seq                 bigserial,
  move_id             text not null,
  item_id             text not null,
  item_name           text not null,
  run_id              text,
  buyer_handle        text,
  buyer_space_id      text,
  buyer_agent_id      text,
  status              text not null,                       -- listed | negotiating | awaiting_owner | scheduled | handed_off | paid | relisted | withdrawn | waiting
  stage               text not null default 'negotiating', -- negotiating | scheduling | handoff | done
  list_cents          integer not null,
  floor_cents         integer,
  last_offer_cents    integer,
  counter_cents       integer,
  counters            integer not null default 0,
  agreed_cents        integer,
  offered_slots       jsonb not null default '[]'::jsonb,
  slot_at             text,
  reschedules         integer not null default 0,
  nudges              integer not null default 0,
  buyer_confirmed     boolean not null default false,
  owner_confirmed     boolean not null default false,
  reliability         real not null default 0.7,
  last_buyer_at       timestamptz,
  last_call_opt_out   boolean not null default false,
  last_call_stage     text not null default 'none',       -- none | dropped | free
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists deal_runs_move_idx on deal_runs (move_id, seq);
create index if not exists deal_runs_item_idx on deal_runs (item_id, seq);
create index if not exists deal_runs_buyer_space_idx on deal_runs (buyer_space_id);

create table if not exists last_call_runs (
  move_id     text primary key,
  run_id      text not null,
  stage       text not null,                               -- drop | free | close | done
  status      text not null default 'waiting',             -- waiting | done
  fired       jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
