-- Erase everything Elfie stored for one owner's phone number, so the next text starts a brand new move
-- (first-contact hello, a fresh onboarding call, a fresh ledger).
--
-- Run it in the Supabase SQL editor, or:  psql "$ELVES_DATABASE_URL" -f scripts/reset-number.sql
-- 1. Change the number in the one `like` below to the last digits of the phone (E.164 is stored, e.g. +14132654302).
-- 2. Run the "Preview" select first and check it is the right move.
-- 3. Run the rest. It is one transaction: it either deletes everything or nothing.

-- Preview
select id, owner_handle, name, created_at from moves where owner_handle like '%4132654302';

begin;

create temp table _mv on commit drop as
  select id, owner_space_id from moves where owner_handle like '%4132654302';

-- every message id the crew saw or sent for those moves, so thread owners and send-keys can be cleared
create temp table _msg on commit drop as
  select id from memory_messages where move_id in (select id from _mv);

delete from thread_owners
 where message_id in (select id from _msg)
    or message_id in (select 'space:' || owner_space_id from _mv)
    or message_id in (select 'space:' || space_id from participants where move_id in (select id from _mv));
delete from sends where message_id in (select id from _msg);
delete from cursors c using _mv m where c.name like '%' || m.id || '%';   -- onboarding, clarify and move-in questions

delete from memory_messages where move_id in (select id from _mv);
delete from memory_threads  where move_id in (select id from _mv);
delete from memory_facts    where move_id in (select id from _mv);
delete from memory_notes    where move_id in (select id from _mv);

-- the move itself: cascades to participants, items, deals and their parties, the crew board, events, housing
-- searches, listings, sublet posts, the move-in checklist, and all of the Money Elf's state (people, entries,
-- waiting approvals, accounts, plans)
delete from moves where id in (select id from _mv);

commit;

-- Verify: both should return 0 rows
select count(*) as moves_left from moves where owner_handle like '%4132654302';
select count(*) as threads_left from memory_threads where handle like '%4132654302';
