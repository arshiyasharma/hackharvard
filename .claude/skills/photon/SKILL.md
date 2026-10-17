---
name: photon
description: What Photon 2.0 (the messaging platform Elves runs on) can and can't send, verified against its live OpenAPI spec, plus how to look things up without mixing it up with Photon 1.0 (Spectrum). Use when building a reply feature that goes beyond plain text (images, polls, links, cards, reactions), when someone asks "can Photon do X", or before writing code against a Photon endpoint.
---

# Photon 2.0 (what Elves uses)

Photon has **two products with separate docs**:
- **Stable = Photon 1.0, "Spectrum".** The `spectrum-ts` SDK, at https://photon.codes/docs/...
- **Beta = Photon 2.0.** The REST API at `https://api.photon.codes/v1`, with docs under https://photon.codes/docs/beta/...

Elves uses **2.0** (project `pho_prj_…`, key `pho_sk_…`). Never copy a Spectrum feature into the plan without checking that 2.0 has it.

## Source of truth: the live OpenAPI spec

The 2.0 messaging docs are still a placeholder ("being rewritten"), so check the spec instead:
```bash
curl -sS https://api.photon.codes/openapi.json -o photon2.json
python3 -c "import json;S=json.load(open('photon2.json'))['components']['schemas'];print(json.dumps(S['SendPollContent'],indent=1))"
```
Outbound content types live under `Send*Content` schemas; inbound ones are the plain `*Content` schemas.

## Verified Oct 17 2026

- **Outbound content types:** `text`, `text.update`, `attachment`, `voice`, `reaction`, `poll`, `poll.update`, `poll.vote`, `group`, `message.read`, `message.delete`, `space.typing.update`, `space.participants.update`.
- **No app cards or mini apps in 2.0.** Spectrum's `app(url, { live: true })` (an iMessage app card through Photon's "Spectrum iMessage App" launcher) is 1.0 only. 2.0 also has no rich-link type: send the URL as text, and iMessage may unfurl it. Previews from unknown numbers can show "tap to load".
- **Polls:** `{type:"poll", question, options:[{id,text}], selectionMode:"single"|"multiple"}`. **The option ids are ours.** A vote arrives as `{type:"poll.vote", selectedOptions:[{id,text}]}`. Still unverified on the shared iMessage pool: whether polls send there at all (the pool refused threaded replies and reactions with 409 `SPACE_NOT_SENDABLE`), and whether option ids survive the round trip. Always keep a text fallback ("Reply yes").
- **Attachments:** upload with `POST /v1/projects/{id}/attachments`. The body is `multipart/related` with exactly two parts: JSON `{contentType, sizeBytes, filename?}`, then the bytes. `sizeBytes` must match the file length. Send it as `{type:"attachment", attachmentId:"pho_att_…"}`. Captions (`metadata.caption`) are accepted on Telegram only, so on iMessage put the words in a separate text message.
- **Shared-pool limits we hit before:** threaded replies and reactions are refused (409 `SPACE_NOT_SENDABLE`, and the transport falls back to a flat send). The pool sends only to a human with an active assignment who has texted first. A dedicated line lifts these limits.

## Before testing live

A live send reaches a real phone. Ask the user before sending anything to the numbers in `.env` (`OWNER_PHONE`, `BUYER_PHONE`). Never print `PHOTON_API_KEY`. When a live test settles one of the "unverified" points above, update this file and log it with the `record-decision` skill.
