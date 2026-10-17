---
name: money-elf-add-dependency
description: Add or upgrade an npm dependency of packages/money-elf the way the team keeps bun.lock clean. Use whenever the Money Elf needs a new package or a version bump.
---

# Add a dependency to the Money Elf

`money-elf` sits on `team-stable` (decision #39), so every workspace is checked out and plain Bun commands are safe.

1. Pin an exact version: `cd packages/money-elf && bun add <pkg>@<exact version>`.
2. Check the lockfile diff only touches what you meant to: `git diff --stat bun.lock`, and look for unrelated removals.
3. The service runs in Docker (Linux), so prefer packages with prebuilt binaries for macOS arm64 and Linux x64 (glibc and musl). If it needs anything at runtime (fonts, native binaries, system libraries), bundle it, the way the Ledger card bundles Inter (decision #33).
4. Run the `verify-money-elf` skill.
5. Log the dependency and why it's needed with `record-decision`.
