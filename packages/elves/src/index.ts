export * from "./contract.ts";
export { crewLead } from "./crew-lead.ts";
export * from "./facts.ts";
export * from "./intake.ts";
export * from "./router.ts";
export { sellElf } from "./sell.ts";
export { stubElves } from "./stubs.ts";

import type { Elf } from "./contract.ts";
import { crewLead } from "./crew-lead.ts";
import { sellElf } from "./sell.ts";
import { stubElves } from "./stubs.ts";

/** The whole crew, Crew Lead first (ties in keyword routing resolve toward the Lead). */
export const allElves: Elf[] = [crewLead, sellElf, ...stubElves];
