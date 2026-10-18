---
name: run-elves-on-phone
description: Run the Elves crew service (with the Money Elf and its Ledger mini app) against your own Photon 2.0 and Spectrum projects, so you can text it from a real iPhone. Use when someone wants to test Elves on their phone, see the Ledger mini app card in iMessage, or debug what a real phone receives.
---

# Run Elves on a real phone

Elves runs on **Photon 2.0** (the conversation). The Moving Ledger dashboard card comes from **Spectrum** (Photon 1.0), which only delivers that one card (decisions #53, #60). Test on *your own* projects, never the team's: the team's Photon line is live (Railway, plus teammates' laptops), and a second copy of the service would answer every text twice.

## One-time setup (the person testing does the sign-ins)

1. **Photon 2.0 project** (app.beta.photon.codes): its project ID and `pho_sk_` key.
2. **Spectrum project** (app.photon.codes, the stable dashboard): its project ID and secret.
3. **`.env.mine`** at the repo root. It's git-ignored by `.env.*`; check with `git check-ignore .env.mine`. Contents:
   - `PHOTON_PROJECT_ID`, `PHOTON_API_KEY`, `PHOTON_INBOUND=poll`, `ELVES_TRANSPORT=photon2`
   - `ELVES_STORE=memory`, and `DATABASE_URL=` / `ELVES_DATABASE_URL=` deliberately blank, so the team database is never touched
   - `ELVES_LISTINGS=fake`, `PORT=8790`
   - `LEDGER_LINK_SECRET=` (random, 48 hex chars)
   - `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`
   - `ANTHROPIC_API_KEY` and `NESSIE_API_KEY`, copied from `.env` without printing them

   Confirm the team's values don't leak in: `bun --env-file=.env.mine -e 'console.log(process.env.OWNER_PHONE)'` must print `undefined`.
4. **Put the phone on Photon's shared iMessage pool:** `bun --env-file=.env.mine run scripts/photon.ts assign +1XXXXXXXXXX`. Note the pool number it prints; that's the Elves number.
5. **Register the phone on Spectrum.** Install the CLI with `npm i -g @photon-ai/cli@2.2.0`. Start `photon login --no-browser` in the user's Terminal panel; **they** approve it in their browser, never you. Then:
   - `photon spectrum users add -p <spectrum id> --phone +1… --first-name … --last-name … --email <their Photon login email>`
   - `photon spectrum profile update -p <spectrum id> --first-name Elves --last-name Ledger`
   - `photon spectrum users ls -p <spectrum id> --json` shows `assignedPhoneNumber`, the Spectrum number.
   - **The person must text that Spectrum number once.** Until they do, sends fail with "Target not allowed for this project".

## Each run

1. **Tunnel**, so the phone can load the mini app: `cloudflared tunnel --no-autoupdate --url http://localhost:8790` (`brew install cloudflared`; ask before installing). Take the `https://….trycloudflare.com` URL from its output. If it logs QUIC or port-7844 errors, the network blocks it: switch to a phone hotspot. Don't use localtunnel or ngrok's free tier; their warning pages appear inside the mini app. The URL changes on every restart.
2. **Service**, in the user's Terminal panel: `PUBLIC_URL=<tunnel url> bun --env-file=.env.mine run apps/elves/src/index.ts`. Check `curl localhost:8790/health` shows `publicUrl` and `"store":"memory"`. A freshly restarted service has forgotten the move, so the next text is first contact again.
3. **Script for the phone**, texted to the Elves (Photon 2.0) number: `hi im moving out nov 1` → `split the $240 truck with Sam and Priya` → `yes` → `I paid a $500 holding deposit on the sublet, due back Dec 1` → `show me my dashboard`. The card from "Elves Ledger" should already arrive after the split, unasked, and update in place after `yes` and the deposit. Tap it: the dashboard should open nearly full screen and scroll. (`SPECTRUM_LIVE_CARD=1` restores the old inline live card, which can't be tapped open.) Then text `paid` from a roommate (or log another deposit): the card should refresh in place (`ledger card refreshed` in the logs). `the truck was actually $260` should reply that past entries can't be changed by text, with no card.

## Reading what happened

- Service logs are in the Terminal tab. Watch for `poll refused` (expected on the shared pool), `image send failed`, `mini app card not sent`, and `ledger card sent` / `refreshed`.
- Photon's side: `bun --env-file=.env.mine run scripts/photon.ts status` lists the last messages in each direction (mask phone numbers before quoting them).
- A Spectrum `SubscribePollEvents UNAVAILABLE` stack trace means its inbound stream dropped (often after a network switch). Sending cards is unaffected.

Stop the service and the tunnel when you're done. Never commit `.env.mine`, and rotate any key that was pasted into a chat.
