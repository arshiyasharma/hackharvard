/** Scam check: deterministic rules, so a flag is explainable and repeatable. A flagged request is never paid. */

export type ScamReason =
  | "overpayment"
  | "sends_mover"
  | "off_platform"
  | "deposit_before_viewing"
  | "below_market"
  | "asks_for_financial_info";

export interface ScamFlag {
  reason: ScamReason;
  /** Plain-words warning for the owner, one sentence. */
  warning: string;
}

const RULES: { reason: ScamReason; re: RegExp; warning: string }[] = [
  {
    reason: "overpayment",
    re: /\b(overpa(y|id|yment)|pay (you )?(extra|more than)|send (me )?(back )?the (difference|extra|rest)|refund the (difference|extra)|(cashier'?s|certified) check|money order)\b/i,
    warning: "Overpaying and asking for the difference back is the classic fake-check scam.",
  },
  {
    reason: "sends_mover",
    re: /\b((send|sending|have|hire) (a|my|our) (mover|movers|shipper|shipping (company|agent)|courier|driver|agent)|my (mover|movers|shipper|courier|driver) will (pick|come|collect))\b/i,
    warning: 'A buyer who "sends a mover" and pays by check is a common scam; real buyers come themselves.',
  },
  {
    reason: "off_platform",
    re: /\b(gift ?cards?|itunes card|steam card|wire (transfer|the money)|western union|moneygram|crypto|bitcoin|btc|usdt|ethereum|(zelle|venmo|cash ?app|paypal) only|pay (me |us )?outside|off (the )?(app|platform)|friends (and|&) family)\b/i,
    warning:
      "Asking for payment outside the Ledger (gift cards, wires, crypto) leaves you no way to get it back.",
  },
  {
    reason: "deposit_before_viewing",
    re: /\b(deposit|first month|holding fee)\b[^.!?\n]{0,60}\b(before|without|prior to)\b[^.!?\n]{0,20}\b(see|seeing|view|viewing|tour|showing|visit)|\b(can'?t|cannot|unable to) (show|tour|meet)\b|\bout of (the )?(country|town)\b[^.!?\n]{0,60}\b(keys?|deposit)\b/i,
    warning: "Never pay a deposit before you've seen the place in person.",
  },
  {
    reason: "asks_for_financial_info",
    re: /\b(send|give|need|share|text|provide|confirm|enter|what'?s|whats)\b[^.!?\n]{0,30}\b(card number|card info|credit card|debit card|cvv|cvc|routing number|account number|bank login|ssn|social security|verification code|2fa code|one[- ]time code)\b/i,
    warning: "Nobody needs your card, bank or login details over text; don't share them.",
  },
];

/** Run the rule set over a message (or forwarded listing). `marketCents` enables the below-market rule. */
export function scamCheck(
  text: string,
  opts: { priceCents?: number | null; marketLowCents?: number | null } = {},
): ScamFlag[] {
  const out: ScamFlag[] = [];
  for (const r of RULES) if (r.re.test(text)) out.push({ reason: r.reason, warning: r.warning });
  const { priceCents, marketLowCents } = opts;
  if (
    priceCents != null &&
    marketLowCents != null &&
    marketLowCents > 0 &&
    priceCents < marketLowCents * 0.5
  ) {
    out.push({
      reason: "below_market",
      warning: "That price is far below market, which usually means it isn't real.",
    });
  }
  return out;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** True when the text seems to contain a card or bank account number (so it is never stored or echoed). */
export function containsFinancialNumber(text: string): boolean {
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return /\b(routing|account|acct|aba)\b[^0-9\n]{0,20}\d{8,17}\b/i.test(text);
}
