-- The Home Elf's move-in week checklist: one row per task per move. due_at is an ISO date derived from the
-- move's move-in date; reminded_at is set once the sweep has nudged the owner about it.

create table if not exists movein_tasks (
  move_id      text not null references moves (id) on delete cascade,
  key          text not null,
  label        text not null,
  due_at       text not null,
  status       text not null default 'open',
  notes        text,
  reminded_at  timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (move_id, key)
);

create index if not exists movein_tasks_due_idx on movein_tasks (due_at) where status = 'open' and reminded_at is null;
