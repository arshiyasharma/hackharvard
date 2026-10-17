/**
 * Send a signed fake Retell `call_ended` webhook to the service, then print what the data layer saved.
 *   bun run mock-call <url> <ownerPhone> [transcript words...]
 *   bun run mock-call http://localhost:3000 +14255269066
 *   bun run mock-call https://elves-production.up.railway.app +14255269066 "I move out Nov 1 and want to sell my couch"
 * Signs with RETELL_API_KEY (bun loads .env), exactly as Retell does. The phone must belong to a move: text the bot first.
 */
import { signRetell } from "@elves/voice";

const [url, phone, ...words] = process.argv.slice(2);
const apiKey = process.env.RETELL_API_KEY;
if (!url || !phone || !apiKey) {
  console.error(
    "usage: bun run mock-call <baseUrl> <ownerPhone> [transcript]   (RETELL_API_KEY must be set)",
  );
  process.exit(1);
}
const said =
  words.join(" ") ||
  "I'm moving out November 1 and I want to sell my couch and my desk. My roommate Sam is helping.";
const now = Date.now();
const callId = `mock_${now}`;
const body = JSON.stringify({
  event: "call_ended",
  call: {
    call_id: callId,
    from_number: phone,
    to_number: process.env.PHOTON_SMS_LINE ?? "+10000000000",
    direction: "inbound",
    transcript: `Agent: Hi, this is the Elves crew. What are you moving?\nUser: ${said}`,
    transcript_object: [
      { role: "agent", content: "Hi, this is the Elves crew. What are you moving?" },
      { role: "user", content: said },
    ],
    start_timestamp: now - 3 * 60_000,
    end_timestamp: now,
  },
});

const base = url.replace(/\/$/, "");
const res = await fetch(`${base}/webhooks/retell`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-retell-signature": signRetell(body, apiKey) },
  body,
});
console.log(`POST /webhooks/retell -> ${res.status} ${await res.text()}  (call ${callId})`);
if (res.status !== 200) process.exit(1);

const moves = (await (await fetch(`${base}/moves`)).json()) as { id: string; ownerHandle: string }[];
const move = moves.find((m) => m.ownerHandle === phone);
if (!move) {
  console.log(`No move for ${phone}. Text the bot once from that phone, then run this again.`);
  process.exit(1);
}
const events = (await (await fetch(`${base}/events/${move.id}`)).json()) as {
  type: string;
  payload: unknown;
}[];
const done = events.find(
  (e) => e.type === "call.completed" && (e.payload as { callId?: string }).callId === callId,
);
console.log(`\nmove ${move.id}`);
console.log(
  done
    ? `call.completed: ${JSON.stringify(done.payload)}`
    : "no call.completed event yet (check the service logs)",
);
console.log(`\nfacts + notes: ${base}/memory/${move.id}`);
console.log(`crew board:    ${base}/b/${move.id}`);
