-- Stuff Elf: what the owner wants done with each item, when its outcome landed, whether it leaves before
-- move day (so the Move-day Elf drops it from the truck estimate), and Last Call progress.
-- 0004 is left for the Deal Engine's 0004_engine.sql.

alter table items add column if not exists intent text not null default 'sell';
alter table items add column if not exists outcome_at timestamptz;
alter table items add column if not exists leaves_before_move_day boolean not null default false;
alter table items add column if not exists last_call_stage text;
