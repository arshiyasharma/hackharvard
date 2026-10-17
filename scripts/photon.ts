/**
 * Operator CLI for the Photon 2.0 project.
 *   bun run photon status              platform mode, assignments, lines, last messages
 *   bun run photon messages [n]        last n received+sent messages
 *   bun run photon assign <phone>      assign a human phone to the shared iMessage pool
 *   bun run photon reply-last <text>   reply (threaded) to the newest received message
 *   bun run photon send <spaceId> <senderId> <text>
 *   bun run photon event-types         webhook/event catalog for this apiVersion
 *   bun run photon provision-dedicated provision a dedicated iMessage line (plan permitting)
 */
import { PhotonApiError, PhotonClient } from "@elves/photon";

const projectId = process.env.PHOTON_PROJECT_ID;
const apiKey = process.env.PHOTON_API_KEY;
if (!projectId || !apiKey) {
  console.error("Set PHOTON_PROJECT_ID and PHOTON_API_KEY (bun loads .env automatically).");
  process.exit(1);
}
const client = new PhotonClient({ projectId, apiKey, baseUrl: process.env.PHOTON_API_ORIGIN });
const [cmd = "status", ...args] = process.argv.slice(2);

function fmt(m: Awaited<ReturnType<typeof client.getMessage>>) {
  const c = m.content as { type: string; text?: string };
  const body = c.type === "text" ? JSON.stringify(c.text) : `<${c.type}>`;
  const to = m.receivedBy?.handle ?? m.addressedTo?.handle ?? "?";
  return `${m.createdAt} ${m.platform} ${m.status.padEnd(9)} ${m.sentBy.handle} -> ${to}  space=${m.space.id} ${m.parentMessageId ? `parent=${m.parentMessageId}` : ""} ${body}`;
}

try {
  switch (cmd) {
    case "status": {
      const [plat, asg, res] = await Promise.all([
        client.getImessagePlatform(),
        client.listAssignments(),
        client.listResources(),
      ]);
      console.log("iMessage platform:", plat);
      console.log("Assignments (human -> pool number):");
      for (const a of asg.assignments)
        console.log(
          `  ${a.handle} -> ${a.assignedPhoneNumber}  (${a.createdAt}${a.releasedAt ? `, released ${a.releasedAt}` : ""})`,
        );
      console.log("Lines:");
      for (const r of res.resources)
        console.log(`  ${r.type} ${r.state} ${JSON.stringify(r.detail)} ${r.abilities.join(",")}`);
      const recv = await client.listMessages({ direction: "received", order: "desc", pageSize: 5 });
      const sent = await client.listMessages({ direction: "sent", order: "desc", pageSize: 5 });
      console.log(`Last received (${recv.items.length}):`);
      for (const m of recv.items) console.log("  " + fmt(m));
      console.log(`Last sent (${sent.items.length}):`);
      for (const m of sent.items)
        console.log("  " + fmt(m) + (m.failure ? ` FAILURE ${JSON.stringify(m.failure)}` : ""));
      break;
    }
    case "messages": {
      const n = Number(args[0] ?? 20);
      const [recv, sent] = await Promise.all([
        client.listMessages({ direction: "received", order: "desc", pageSize: n }),
        client.listMessages({ direction: "sent", order: "desc", pageSize: n }),
      ]);
      const all = [...recv.items, ...sent.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const m of all) console.log(fmt(m) + (m.failure ? ` FAILURE ${JSON.stringify(m.failure)}` : ""));
      break;
    }
    case "assign": {
      const phone = args[0];
      if (!phone) throw new Error("usage: assign <E.164 phone>");
      const a = await client.createAssignment(phone, `assign:${phone}`);
      console.log(`${a.handle} -> ${a.assignedPhoneNumber}`);
      break;
    }
    case "reply-last": {
      const text = args.join(" ");
      if (!text) throw new Error("usage: reply-last <text>");
      const recv = await client.listMessages({ direction: "received", order: "desc", pageSize: 1 });
      const m = recv.items[0];
      if (!m?.receivedBy) throw new Error("no received message to reply to");
      const sent = await client.sendText(
        { spaceId: m.space.id, senderId: m.receivedBy.id, text, parentMessageId: m.id },
        `cli-reply:${m.id}:${Date.now()}`,
      );
      console.log("accepted:", sent.id, sent.status);
      break;
    }
    case "send": {
      const [spaceId, senderId, ...rest] = args;
      if (!spaceId || !senderId || !rest.length) throw new Error("usage: send <spaceId> <senderId> <text>");
      const sent = await client.sendText(
        { spaceId, senderId, text: rest.join(" ") },
        `cli-send:${Date.now()}`,
      );
      console.log("accepted:", sent.id, sent.status);
      break;
    }
    case "event-types": {
      console.log(JSON.stringify(await client.listWebhookEventTypes(), null, 2));
      break;
    }
    case "provision-dedicated": {
      console.log(JSON.stringify(await client.provisionDedicatedLine(`dedicated:${projectId}`), null, 2));
      break;
    }
    default:
      console.error(`unknown command ${cmd}`);
      process.exit(2);
  }
} catch (err) {
  if (err instanceof PhotonApiError) {
    console.error(`Photon API error ${err.status} ${err.code ?? ""}: ${err.message}`);
    if (err.body) console.error(JSON.stringify(err.body, null, 2).slice(0, 2000));
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exit(1);
}
