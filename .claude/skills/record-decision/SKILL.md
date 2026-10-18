---
name: record-decision
description: Append a decision made while building the Money Elf to money-elf-decisions.md. Use whenever the user and Claude settle a design, scope, API or behavior choice for the Money Elf (answers to clarifying questions, defaults Claude picked, things learned that change the design), or when the user says "record/log this decision".
---

# Record a Money Elf decision

The team keeps every Money Elf decision in `money-elf-decisions.md` at the repo root, so reviewers and the rest of the crew can see why the code is the way it is.

1. Read `money-elf-decisions.md`. Find the last numbered entry, and check whether the decision is already logged. If it is, update that entry in place instead of adding a duplicate. If the new decision reverses an old one, add the new entry and mark the old one `**Superseded by #N.**`.
2. If today's date (YYYY-MM-DD) has no `## <date>` heading yet, add one at the bottom.
3. Append one numbered entry under it, continuing the numbering:
   `N. **<the decision in one bold sentence>.** <why, in one or two sentences>. (<who>)`
   - `<who>` is `team` when the user decided or confirmed it in chat, and `Claude` when Claude chose a default the team can override.
   - Name the file or function it affects when there is one (for example `packages/money-elf/src/service.ts`).
4. Never put secrets, API keys or personal phone numbers in the file.
5. Tell the user in one line which entry you added or changed.
