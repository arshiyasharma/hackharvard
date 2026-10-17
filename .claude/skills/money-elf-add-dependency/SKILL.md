---
name: money-elf-add-dependency
description: Add or upgrade an npm dependency of packages/money-elf without wrecking the shared bun.lock. Use whenever the Money Elf needs a new package (or a version bump), or when someone is about to run `bun add` / `bun install` on the money-elf branch.
---

# Add a dependency to the Money Elf

**Why this is special:** on `money-elf`, the root `bun.lock` also lists the foundation branch's packages (`packages/elves`, `photon`, `llm`, …), which aren't checked out here (decision #25). Running `bun add` or `bun install` here would prune them, and the lockfile would then fight the foundation's on merge. So the dependency is added in a temporary worktree of `phase-1-foundation`, where every workspace exists.

Run from the repo root on `money-elf`, with `<pkg>@<exact version>` (pin exact versions):

1. Make a worktree of the foundation branch in the scratchpad, and copy our package and lockfile into it:
   ```bash
   WT=<scratchpad>/wt && git worktree add -q $WT phase-1-foundation
   cp -R packages/money-elf $WT/packages/ && cp bun.lock tsconfig.json $WT/
   (cd $WT/packages/money-elf && bun add <pkg>@<version>)
   ```
2. Check the merged lockfile only **adds** lines and still lists the foundation workspaces:
   `git -C $WT diff --stat bun.lock` and `grep -n '"packages/elves"' $WT/bun.lock`.
3. Copy the results back: `cp $WT/bun.lock bun.lock` and `cp $WT/packages/money-elf/package.json packages/money-elf/package.json`.
4. Make the package importable here. The simplest way is `bun install --no-save`, which installs from the lockfile and leaves it byte-identical (verified Oct 17 2026). If that doesn't work, copy the folders by hand. Bun uses an isolated layout (`$WT/node_modules/.bun/<name>@<version>/node_modules/<name>`), so copy the real folders, following symlinks, into `packages/money-elf/node_modules/` (gitignored). For a package with a native binary, also copy this machine's platform package next to it (for example `@resvg/resvg-js-darwin-arm64`):
   ```bash
   cp -RL $WT/node_modules/.bun/<name>@<version>/node_modules/<name> packages/money-elf/node_modules/<scope>/
   ```
5. Remove the worktree: `git worktree remove --force $WT && git worktree prune`.
6. Run the `verify-money-elf` skill, and log the new dependency and why it's needed with `record-decision`.

Prefer packages with prebuilt binaries for both macOS arm64 and Linux x64 (glibc and musl), since the service runs in Docker. Note in the decision whether it needs anything at runtime (fonts, binaries).
