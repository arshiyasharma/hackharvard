/**
 * Onboarding-call eval: three simulated owners (Haiku, with hidden ground truth) each text the crew, and the
 * Crew Lead (Sonnet) runs the call under each prompt variant. Scored on owner turns, questions asked, how much
 * of the truth landed in the confirmed brief, nuance captured, and planning leaks before the yes.
 *
 *   bun run scripts/onboarding-eval.ts                 # all variants, all personas
 *   bun run scripts/onboarding-eval.ts sweep mirror    # chosen variants
 *   EVAL_OUT=/tmp/eval bun run scripts/onboarding-eval.ts   # transcripts and json go there
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { ONBOARDING_PROMPTS, type OnboardingPromptId } from "@elves/elves";
import { FakeListings } from "@elves/listings";
import { ClaudeLLM, z } from "@elves/llm";
import { InMemoryBackend, MoveMemory } from "@elves/memory";
import { ScriptTransport } from "@elves/photon";
import {
  createLogger,
  MemoryStore,
  type OnboardingState,
  onboardingKey,
  parseOnboardingState,
} from "@elves/shared";
import { createService } from "../apps/elves/src/service.ts";

const MAX_OWNER_TURNS = 9;
const OUT = process.env.EVAL_OUT ?? ".data/onboarding-eval";

interface Persona {
  id: string;
  name: string;
  opening: string;
  style: string;
  /** The hidden truth the owner answers from. */
  facts: Record<string, unknown>;
  /** Flat statements the judge checks the brief against. Essentials first. */
  truths: string[];
  /** Nuance that only comes out when the owner is invited to share. */
  nuance: string[];
}

const PERSONAS: Persona[] = [
  {
    id: "maya",
    name: "Maya",
    opening: "hey i'm moving out of my allston apartment end of november and need help getting rid of stuff",
    style: "BU senior, lowercase, quick, a little stressed, answers only what's asked",
    facts: {
      moveOut: "2026-11-30, lease ends that day, no flexibility",
      from: "Allston (Gardner St), 3rd floor walkup, no elevator",
      to: "no place yet; wants a room in Somerville or Cambridge under $1100/mo from Dec 1",
      moveIn: "Dec 1 ideally",
      items: "grey couch (sell; paid $400, hoping $150), desk (donate), bed (keep), mini fridge (undecided)",
      people: "roommate Sam has a car and is free on weekends; Maya is never free mornings",
      lease: "ending normally; landlord is sketchy about returning deposits",
      money: "Venmo; wants to spend under $300 total; cheapest option wins",
      transport: "undecided, probably Sam's car plus one U-Haul trip",
      worry: "couch won't sell in time and she'll have to dump it",
    },
    truths: [
      "move-out date is 2026-11-30 and it is a hard date (lease ends)",
      "moving from Allston",
      "needs a place found: a room in Somerville or Cambridge under $1100/mo from Dec 1",
      "couch is for sale",
      "desk is to donate",
      "bed is kept",
      "roommate Sam is involved (has a car, free weekends)",
      "lease is ending normally",
      "transport undecided / Sam's car plus a U-Haul",
      "3rd floor walkup with no elevator",
      "pays with Venmo",
      "budget around $300",
    ],
    nuance: [
      "worried the couch won't sell in time",
      "landlord is sketchy about deposits",
      "never available mornings",
      "paid $400 for the couch and hopes for about $150",
      "optimizes for cheapest",
      "mini fridge is undecided",
    ],
  },
  {
    id: "daniel",
    name: "Daniel",
    opening:
      "Hi! My partner and I are relocating from Boston to Chicago in mid November for my new job. Can you help us plan?",
    style: "organized, full sentences, polite, volunteers one detail when it fits",
    facts: {
      moveOut: "around 2026-11-15, can shift a few days either way",
      from: "South End, Boston, 2nd floor, elevator building with a loading zone",
      to: "Logan Square, Chicago; apartment already signed, move-in 2026-11-18",
      gap: "two nights in a hotel between",
      items: "sell the couch, dining table and bookshelf; keep clothes, books, the record player",
      people: "partner Priya; no other helpers",
      lease:
        "breaking early, 2 months left; landlord says they must find a replacement tenant, so they need to sublet it out",
      money: "budget $2500; pays with Zelle; least effort matters more than price",
      transport: "undecided between movers and a one-way U-Haul; wants quotes",
      moveIn: "needs internet set up at the new place before arriving",
      worry: "the cost of breaking the lease",
    },
    truths: [
      "move-out around 2026-11-15, flexible by a few days",
      "moving from South End, Boston to Logan Square, Chicago (long distance)",
      "destination apartment already signed, move-in 2026-11-18",
      "couch, dining table and bookshelf are for sale",
      "clothes, books and the record player are kept",
      "partner Priya is moving too",
      "breaking the lease early with 2 months left; must find a replacement tenant / sublet out",
      "transport undecided between movers and a one-way U-Haul",
      "budget $2500",
      "two-night hotel gap",
      "pays with Zelle",
      "needs internet set up at the new place",
    ],
    nuance: [
      "least effort matters more than price",
      "worried about the cost of breaking the lease",
      "elevator building with a loading zone",
      "wants quotes for both movers and a U-Haul",
    ],
  },
  {
    id: "lin",
    name: "Lin",
    opening: "moving from cambridge to brighton with my two roommates jan 31, we have a piano lol",
    style: "dry, terse, lowercase, sometimes answers two questions in one line",
    facts: {
      moveOut: "2027-01-31, firm",
      moveIn: "2027-02-01",
      from: "Cambridge (Inman Sq), 2nd floor, narrow stairs",
      to: "Brighton, Washington St; building has a loading dock and requires an elevator reservation",
      items: "upright piano (sell, needs two people, hoping $500+), two rugs (donate), everything else kept",
      people: "roommates Jess and Omar moving too; the three split the truck evenly; Omar can drive",
      lease: "ending normally, nothing to do",
      money: "split three ways; cheapest; pays Venmo or cash",
      transport: "leaning movers because of the piano, open to a truck if much cheaper",
      availability: "only after 6pm on weekdays, any time weekends",
      worry: "the piano going down the narrow stairs",
    },
    truths: [
      "move-out 2027-01-31, firm",
      "move-in 2027-02-01",
      "from Cambridge to Brighton (same city)",
      "upright piano is for sale",
      "two rugs are to donate",
      "everything else is kept",
      "roommates Jess and Omar are moving too",
      "the truck cost is split three ways",
      "transport leaning movers because of the piano, open to a truck",
      "lease ending normally",
      "destination has a loading dock and needs an elevator reservation",
      "narrow stairs at the current place",
    ],
    nuance: [
      "the piano needs two people and is the big worry on the stairs",
      "hoping $500 or more for the piano",
      "only available after 6pm on weekdays",
      "cheapest option preferred",
      "Omar can drive",
    ],
  },
];

const claude = new ClaudeLLM();

async function ownerSays(p: Persona, transcript: { who: "owner" | "crew"; text: string }[]): Promise<string> {
  return claude.draft({
    model: "fast",
    maxTokens: 300,
    system: `You are ${p.name}, texting a moving-crew service from your phone. Style: ${p.style}.
Your real situation (answer only from this; it is private, the crew does not have it):
${JSON.stringify(p.facts, null, 2)}

Rules:
- Text like a real person: one to three short sentences, no lists, no headers.
- Answer what the crew asked using only your facts. If they ask about something your facts do not cover, say you don't know or haven't decided.
- If the crew asks several things at once, answer all of them in one text.
- If the crew leaves an open door ("anything I should know?"), share one worry or detail from your facts that they have not heard yet.
- Volunteer at most one extra detail per text otherwise, only when it fits naturally.
- If the crew plays back a summary and asks you to confirm: reply exactly "yes" when nothing in it is wrong (missing nice-to-haves are fine); otherwise correct only what is wrong in one short text.
- Never ask the crew questions. Output only the text message.`,
    user: `Conversation so far:\n${transcript.map((t) => `${t.who === "owner" ? "You" : "Crew"}: ${t.text}`).join("\n\n")}\n\nWrite your next text.`,
  });
}

const Judgement = z.object({
  truths: z.array(z.object({ statement: z.string(), captured: z.boolean() })),
  nuance: z.array(z.object({ statement: z.string(), captured: z.boolean() })),
  wrong: z.array(z.string()).describe("things the brief states that contradict the owner's facts"),
});

async function judge(p: Persona, brief: unknown) {
  return claude.extract(Judgement, {
    system:
      "You grade a moving brief against the owner's real facts. A statement is captured when the brief records it in substance (any phrasing, any field). Be strict about essentials and fair about phrasing.",
    user: `Owner's real facts:\n${JSON.stringify(p.facts, null, 2)}\n\nStatements to check (truths):\n${p.truths.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\nNuance to check:\n${p.nuance.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\nThe brief:\n${JSON.stringify(brief, null, 2)}`,
  });
}

const PLANNING_LEAK =
  /\b(I'?ll (list|post|book|search|find|look|check|get|start|line up|price|set up)|we'?ll (list|post|book|search|find|look|check|get|start|line up|price|set up)|on it|listing it|stuff elf|home elf|money elf|move-?day elf|crew board|I can (list|book|find|search))\b/i;

interface RunResult {
  variant: OnboardingPromptId;
  persona: string;
  confirmed: boolean;
  ownerTurns: number;
  askTurns: number;
  questions: number;
  crewChars: number;
  leaks: string[];
  truthScore: number;
  nuanceScore: number;
  wrong: string[];
  transcript: { who: "owner" | "crew"; text: string }[];
  brief: unknown;
}

async function runOne(variant: OnboardingPromptId, p: Persona): Promise<RunResult> {
  const transport = new ScriptTransport("usr_agent", "+16280000000", `${variant}-${p.id}-`);
  const store = new MemoryStore();
  const llm = claude;
  const memory = new MoveMemory({
    backend: new InMemoryBackend(),
    store,
    llm,
    logger: createLogger("memory", "error"),
  });
  const service = createService({
    store,
    transport,
    llm,
    memory,
    listings: new FakeListings(),
    debounceMs: 50,
    publicUrl: null,
    logger: createLogger(`eval:${variant}:${p.id}`, "error"),
    sweepMs: 0,
  });
  const ctrl = new AbortController();
  void service.run(ctrl.signal);
  const owner = `+1617${String(Math.abs(hash(`${variant}${p.id}`)))
    .padStart(7, "0")
    .slice(0, 7)}`;
  const transcript: RunResult["transcript"] = [];
  let printed = 0;
  let questions = 0;
  let crewChars = 0;
  const leaks: string[] = [];
  let state: OnboardingState | null = null;
  let ownerTurns = 0;

  const say = async (text: string) => {
    ownerTurns++;
    transcript.push({ who: "owner", text });
    transport.push(owner, text);
    await transport.settled();
    await service.pipeline.idle();
    const move = (await store.listMoves())[0];
    const wasConfirmed = state?.status === "confirmed";
    for (const s of transport.sent.slice(printed)) {
      transcript.push({ who: "crew", text: s.text });
      if (!wasConfirmed) {
        questions += (s.text.match(/\?/g) ?? []).length;
        crewChars += s.text.length;
        const m = s.text.match(PLANNING_LEAK);
        if (m && !/^Locked in\./.test(s.text)) leaks.push(m[0]);
      }
    }
    printed = transport.sent.length;
    state = move ? parseOnboardingState(await store.getCursor(onboardingKey(move.id))) : null;
  };

  await say(p.opening);
  while (ownerTurns < MAX_OWNER_TURNS && state && (state as OnboardingState).status !== "confirmed") {
    const reply = await ownerSays(p, transcript);
    await say(reply);
  }
  ctrl.abort();
  const finalState = state as OnboardingState | null;
  const brief = finalState?.brief ?? null;
  const j = brief ? await judge(p, brief) : { truths: [], nuance: [], wrong: ["no brief"] };
  const pct = (xs: { captured: boolean }[]) =>
    xs.length ? xs.filter((x) => x.captured).length / xs.length : 0;
  return {
    variant,
    persona: p.id,
    confirmed: finalState?.status === "confirmed",
    ownerTurns,
    askTurns: finalState?.askTurns ?? 0,
    questions,
    crewChars,
    leaks,
    truthScore: pct(j.truths),
    nuanceScore: pct(j.nuance),
    wrong: j.wrong,
    transcript,
    brief,
  };
}

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

const variants = (process.argv.slice(2).filter((v) => v in ONBOARDING_PROMPTS) as OnboardingPromptId[]).length
  ? (process.argv.slice(2).filter((v) => v in ONBOARDING_PROMPTS) as OnboardingPromptId[])
  : (Object.keys(ONBOARDING_PROMPTS) as OnboardingPromptId[]);
mkdirSync(OUT, { recursive: true });
const results: RunResult[] = [];
for (const variant of variants) {
  process.env.ELVES_ONBOARDING_PROMPT = variant;
  console.log(`\n=== ${variant} ===`);
  const batch = await Promise.all(PERSONAS.map((p) => runOne(variant, p)));
  for (const r of batch) {
    results.push(r);
    const lines = r.transcript.map(
      (t) => `${t.who === "owner" ? "👤" : "🧝"} ${t.text.replace(/\n/g, "\n   ")}`,
    );
    writeFileSync(
      `${OUT}/${variant}-${r.persona}.txt`,
      `${lines.join("\n\n")}\n\n--- brief ---\n${JSON.stringify(r.brief, null, 2)}\n`,
    );
    console.log(
      `${r.persona.padEnd(7)} confirmed=${r.confirmed ? "yes" : "NO "} ownerTurns=${r.ownerTurns} askTurns=${r.askTurns} questions=${r.questions} chars=${r.crewChars} truth=${(r.truthScore * 100).toFixed(0)}% nuance=${(r.nuanceScore * 100).toFixed(0)}% leaks=${r.leaks.length}${r.leaks.length ? ` (${r.leaks.join(" | ")})` : ""}${r.wrong.length ? ` wrong=${JSON.stringify(r.wrong)}` : ""}`,
    );
  }
}
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));

console.log("\n=== summary (mean over personas) ===");
console.log("variant        confirmed  ownerTurns  askTurns  questions  chars  truth  nuance  leaks");
for (const v of variants) {
  const rs = results.filter((r) => r.variant === v);
  const mean = (f: (r: RunResult) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
  console.log(
    `${v.padEnd(14)} ${String(rs.filter((r) => r.confirmed).length + "/" + rs.length).padEnd(10)} ${mean(
      (r) => r.ownerTurns,
    )
      .toFixed(1)
      .padEnd(11)} ${mean((r) => r.askTurns)
      .toFixed(1)
      .padEnd(9)} ${mean((r) => r.questions)
      .toFixed(1)
      .padEnd(10)} ${mean((r) => r.crewChars)
      .toFixed(0)
      .padEnd(
        6,
      )} ${(mean((r) => r.truthScore) * 100).toFixed(0).padEnd(5)}% ${(mean((r) => r.nuanceScore) * 100).toFixed(0).padEnd(6)}% ${mean((r) => r.leaks.length).toFixed(1)}`,
  );
}
console.log(`\ntranscripts in ${OUT}/`);
