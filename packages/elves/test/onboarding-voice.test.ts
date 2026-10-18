import { describe, expect, test } from "bun:test";
import { DEFAULT_VOICE_ONBOARDING_PROMPT, VOICE_ONBOARDING_PROMPTS } from "@elves/elves";
import { emptyBrief } from "@elves/shared";

/** Every key of the Brief, nested, as the payload section of the prompt must spell it. */
function keysOf(obj: unknown, out: string[] = []): string[] {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      out.push(k);
      keysOf(v, out);
    }
  }
  return out;
}

describe("voice onboarding prompts", () => {
  test("the default variant exists", () => {
    expect(VOICE_ONBOARDING_PROMPTS[DEFAULT_VOICE_ONBOARDING_PROMPT]).toBeString();
  });

  for (const [id, prompt] of Object.entries(VOICE_ONBOARDING_PROMPTS)) {
    test(`${id}: the submit_brief payload names every Brief field`, () => {
      // housing is null in the empty brief; its keys are checked by name below.
      const keys = keysOf(emptyBrief()).concat(
        "name",
        "category",
        "intent",
        "notes",
        "kind",
        "areas",
        "budgetMonthlyUsd",
        "from",
        "until",
        "mustHaves",
        "status",
      );
      const payload = prompt.slice(prompt.indexOf("THE submit_brief PAYLOAD"));
      for (const k of new Set(keys)) expect(payload).toContain(`"${k}"`);
    });

    test(`${id}: wires the Retell pieces and only gathers`, () => {
      expect(prompt).toContain("{{today}}");
      expect(prompt).toContain("call submit_brief");
      expect(prompt).toContain("end_call");
      expect(prompt).toContain('"Does that all sound right, or is there anything to change?"');
      expect(prompt).toContain("You never name or describe a specialist");
    });
  }
});
