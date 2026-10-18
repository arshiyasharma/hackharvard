/**
 * Prints what to paste into the Retell dashboard for the Crew Lead onboarding call: the general prompt, the
 * begin message, and the submit_brief custom function (name, description, parameters JSON schema).
 *
 *   bun run scripts/retell-agent.ts              # the default variant (story_first)
 *   bun run scripts/retell-agent.ts --json       # the function's parameters schema only, for the JSON editor
 */
import {
  DEFAULT_VOICE_ONBOARDING_PROMPT,
  retellSubmitBriefTool,
  VOICE_BEGIN_MESSAGE,
  VOICE_ONBOARDING_PROMPTS,
} from "@elves/elves";

const tool = retellSubmitBriefTool();
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(tool.parameters, null, 2));
  process.exit(0);
}

const rule = (title: string) => `\n${"=".repeat(8)} ${title} ${"=".repeat(Math.max(0, 70 - title.length))}\n`;
console.log(rule(`GENERAL PROMPT (${DEFAULT_VOICE_ONBOARDING_PROMPT})`));
console.log(VOICE_ONBOARDING_PROMPTS[DEFAULT_VOICE_ONBOARDING_PROMPT]);
console.log(rule("BEGIN MESSAGE (agent speaks first)"));
console.log(VOICE_BEGIN_MESSAGE);
console.log(rule("CUSTOM FUNCTION"));
console.log(`Name: ${tool.name}`);
console.log(`Description: ${tool.description}`);
console.log(
  "Method: POST. Payload: args only: OFF. Talk After Action Completed: ON. Talk While Waiting: OFF.",
);
console.log("Headers: X-Elves-Secret: <ELVES_RETELL_SECRET>");
console.log("Parameters (JSON editor):");
console.log(JSON.stringify(tool.parameters, null, 2));
