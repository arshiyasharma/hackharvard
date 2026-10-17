export * from "./contract.ts";
export { crewLead } from "./crew-lead.ts";
export * from "./deal.ts";
export * from "./facts.ts";
export * from "./home.ts";
export * from "./home-facts.ts";
export * from "./home-followups.ts";
export * from "./home-lease.ts";
export * from "./home-movein.ts";
export * from "./home-rank.ts";
export * from "./home-sublet.ts";
export * from "./intake.ts";
export * from "./router.ts";
export { stuffElf } from "./sell.ts";
export { stubElves } from "./stubs.ts";

import type { Elf } from "./contract.ts";
import { crewLead } from "./crew-lead.ts";
import { homeElf } from "./home.ts";
import { stuffElf } from "./sell.ts";
import { stubElves } from "./stubs.ts";

/** The whole crew, Crew Lead first (ties in keyword routing resolve toward the Lead); Home last, as before. */
export const allElves: Elf[] = [crewLead, stuffElf, ...stubElves, homeElf];
