/**
 * The Ledger mini app card, sent through Spectrum (Photon 1.0). Photon 2.0, which carries the Elves
 * conversation, has no app cards (decision #32), so the card comes from the project's Spectrum line and opens
 * the Moving Ledger dashboard (ledger-page.ts) inside Messages via Photon's Spectrum iMessage App.
 *
 * Verified live Oct 18 2026: the shared pool only reaches a phone that is a registered Spectrum user AND has
 * texted the Spectrum line once ("Target not allowed for this project" otherwise). Cards render in the Spectrum
 * app (App Store id 6777616651); the caption and image come from the page's Open Graph tags.
 *
 * Cards are sent static, not `live`: a live card renders the page inline in the transcript, where it can't be
 * tapped open or scrolled (it sat there like an image in the phone test). A static card shows the og:image
 * preview, and a tap opens the dashboard in the expanded view, nearly full screen and scrollable.
 * SPECTRUM_LIVE_CARD=1 brings the inline live view back.
 */
import { app as appCard, edit, Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";

export interface MiniAppSender {
  /** Send (or, if one is already out to this handle, refresh in place) the Ledger card. */
  send(handle: string, url: string): Promise<void>;
  /** Refresh the last card sent to this handle in place, so it reflects an edit. No-op if none was sent. */
  refresh(handle: string): Promise<void>;
  stop(): Promise<void>;
}

type SpectrumApp = Awaited<ReturnType<typeof Spectrum>>;
/** The one thing a sent card needs from its conversation: sending into it again (an edit). */
interface Space {
  send(content: ReturnType<typeof appCard>): Promise<unknown>;
}

interface SentCard {
  space: Space;
  message: unknown;
  url: string;
}

export class SpectrumMiniApps implements MiniAppSender {
  private readonly cards = new Map<string, SentCard>();

  private constructor(
    private readonly spectrum: SpectrumApp,
    /** Render the page inline in the transcript (live) instead of a tap-to-open preview. */
    private readonly live: boolean,
    private readonly log: {
      info: (m: string, d?: Record<string, unknown>) => void;
      warn: (m: string, d?: Record<string, unknown>) => void;
    },
  ) {
    // Texts to the Spectrum line aren't a conversation: point people back to the Elves number.
    void (async () => {
      try {
        for await (const [space, message] of spectrum.messages) {
          const c = message.content as { type?: string };
          if (c.type !== "text") continue;
          await space.send(
            "This number only sends your Moving Ledger. Text your Elves number to talk to the crew.",
          );
        }
      } catch (err) {
        this.log.warn("spectrum inbound loop ended", { error: String(err) });
      }
    })();
  }

  /** A sender when SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET are set, else null (no mini app cards). */
  static async fromEnv(
    env: Record<string, string | undefined>,
    log: SpectrumMiniApps["log"],
  ): Promise<SpectrumMiniApps | null> {
    if (!env.SPECTRUM_PROJECT_ID || !env.SPECTRUM_PROJECT_SECRET) return null;
    const spectrum = await Spectrum({
      projectId: env.SPECTRUM_PROJECT_ID,
      projectSecret: env.SPECTRUM_PROJECT_SECRET,
      providers: [imessage.config()],
    });
    return new SpectrumMiniApps(spectrum, env.SPECTRUM_LIVE_CARD === "1", log);
  }

  async send(handle: string, url: string): Promise<void> {
    const prior = this.cards.get(handle);
    if (prior) {
      // Same person, new request: move the existing card to the latest URL rather than stacking bubbles.
      prior.url = url;
      await this.refresh(handle);
      return;
    }
    const im = imessage(this.spectrum);
    const user = await im.user(handle);
    const space: Space = await im.space.create(user);
    const message = await space.send(this.card(url));
    this.cards.set(handle, { space, message, url });
    this.log.info("ledger card sent", { url: redact(url) });
  }

  async refresh(handle: string): Promise<void> {
    const card = this.cards.get(handle);
    if (!card) return;
    // A changed URL makes Messages refetch the card's preview; the page itself always reads the live Ledger.
    const fresh = `${card.url}${card.url.includes("?") ? "&" : "?"}v=${Date.now()}`;
    await card.space.send(edit(this.card(fresh), card.message as Parameters<typeof edit>[1]));
    this.log.info("ledger card refreshed", { url: redact(card.url) });
  }

  private card(url: string) {
    return this.live ? appCard(url, { live: true }) : appCard(url);
  }

  async stop(): Promise<void> {
    await this.spectrum.stop();
  }
}

/** Log URLs without their signing token. */
function redact(url: string): string {
  return url.replace(/([?&]t=)[^&]+/, "$1…");
}
