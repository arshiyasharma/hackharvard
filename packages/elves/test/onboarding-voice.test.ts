import { describe, expect, test } from "bun:test";
import {
  briefFromWire,
  briefToWire,
  DEFAULT_VOICE_ONBOARDING_PROMPT,
  retellSubmitBriefTool,
  SubmitBriefArgs,
  VOICE_BEGIN_MESSAGE,
  VOICE_ONBOARDING_PROMPTS,
} from "@elves/elves";
import { emptyBrief } from "@elves/shared";

/** Every key of the Brief, nested, as the function schema must name it. */
function keysOf(obj: unknown, out: string[] = []): string[] {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      out.push(k);
      keysOf(v, out);
    }
  }
  return out;
}

describe("voice onboarding (Retell)", () => {
  test("the default variant exists and the begin message hands the caller the floor", () => {
    expect(VOICE_ONBOARDING_PROMPTS[DEFAULT_VOICE_ONBOARDING_PROMPT]).toBeString();
    expect(VOICE_BEGIN_MESSAGE).toContain("walk me through the move");
    // it says exactly what the crew does and doesn't, never "tell me anything"
    expect(VOICE_BEGIN_MESSAGE).toContain("The Home Elf finds you a place");
    expect(VOICE_BEGIN_MESSAGE).toContain("We don't book trucks or movers");
  });

  test("submit_brief tool is a Retell-shaped custom function naming every Brief field", () => {
    const tool = retellSubmitBriefTool();
    expect(tool.name).toBe("submit_brief");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.$schema).toBeUndefined();
    const text = JSON.stringify(tool.parameters);
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
    for (const k of new Set(keys)) expect(text).toContain(`"${k}"`);
    // No nullables on the wire: unknowns are "" and -1, as with the text call.
    expect(text).not.toContain('"null"');
  });

  test("a submit_brief payload round-trips through the wire brief", () => {
    const wire = { ...briefToWire(emptyBrief()), status: "confirmed" as const };
    const parsed = SubmitBriefArgs.parse(wire);
    expect(parsed.status).toBe("confirmed");
    const { status: _, ...rest } = parsed;
    expect(briefFromWire(rest)).toEqual(emptyBrief());
  });

  for (const [id, prompt] of Object.entries(VOICE_ONBOARDING_PROMPTS)) {
    test(`${id}: Retell shape, built-in variables, tool calls at the right points, gathers only`, () => {
      expect(prompt).toContain("## Role");
      expect(prompt).toContain("## Call flow");
      expect(prompt).toContain("## Closing");
      expect(prompt).toContain("{{current_time}}");
      expect(prompt).toContain("{{user_number}}");
      expect(prompt).toContain("call `submit_brief` with status confirmed");
      expect(prompt).toContain("`submit_brief` with status unconfirmed");
      expect(prompt).toContain("call `end_call`");
      expect(prompt).toContain('"Does that all sound right, or is there anything to change?"');
      expect(prompt).toContain("You name an Elf only when saying what the crew can do");
      expect(prompt).toContain("## What the crew cannot do");
      expect(prompt.split(/\s+/).length).toBeLessThan(1100);
    });
  }
});
