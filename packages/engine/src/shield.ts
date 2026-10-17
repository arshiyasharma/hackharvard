/**
 * Scam Shield for counterparty texts. Money only moves through escrow, so any request to pay (or be paid)
 * another way trips it; the patterns marked severe are the classic marketplace scams and end the conversation.
 */
export interface ShieldHit {
  flag: string;
  severe: boolean;
}

const RULES: { flag: string; severe: boolean; re: RegExp }[] = [
  {
    flag: "pay_outside_escrow",
    severe: false,
    re: /\b(zelle|venmo|cash ?app|paypal|apple ?pay|google ?pay|crypto|bitcoin|btc|usdt|wire (?:transfer|you|the money)|western union|moneygram)\b/i,
  },
  { flag: "gift_card", severe: true, re: /\bgift ?cards?\b/i },
  { flag: "check_payment", severe: true, re: /\b(cashier'?s check|certified check|money order|send (?:you )?a check)\b/i },
  {
    flag: "verification_code",
    severe: true,
    re: /\b(verification code|verify (?:you|that you)|google voice|\d-digit code|send (?:me )?(?:the|that|a) code|code (?:i|we) (?:just )?sent)\b/i,
  },
  {
    flag: "overpayment",
    severe: true,
    re: /\b(overpa(?:y|id)|extra (?:for|to cover) (?:the )?(?:mover|shipping|shipper)|send (?:back )?the difference|refund the (?:extra|difference))\b/i,
  },
  {
    flag: "remote_buyer",
    severe: true,
    re: /\b(i'?m (?:abroad|overseas|out of the country|deployed|offshore)|ship (?:it|this) to me|my (?:mover|agent|assistant|driver|shipper) will (?:pick|come|collect))\b/i,
  },
  { flag: "off_platform_link", severe: false, re: /\b(?:bit\.ly|tinyurl\.com|t\.me)\/\S+/i },
];

export function shield(text: string): ShieldHit[] {
  return RULES.filter((r) => r.re.test(text)).map(({ flag, severe }) => ({ flag, severe }));
}
