/**
 * Type-level check, run by `tsc`: the Money Elf fits the crew's Elf contract as is.
 * If team-stable changes ElfContext/ElfResult (a new Role, a renamed field), the typecheck fails here first.
 */
import type { Elf, ElfContext } from "@elves/elves";
import { moneyElfFromEnv } from "../src/index.ts";

const money = moneyElfFromEnv({});
export const moneyAsCrewElf: Elf = { ...money, handle: (ctx: ElfContext) => money.handle(ctx) };
