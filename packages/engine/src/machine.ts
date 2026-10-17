import type { DealState } from "@elves/shared";

/**
 * The deal lifecycle. A walk-away or no-show sends a deal back to the inbound queue (listed / negotiating);
 * Last Call relists anything unsold; paid, donated and dumped are terminal, and so is a free hand-off.
 */
const NEXT: Record<DealState, readonly DealState[]> = {
  listed: ["negotiating", "scheduled", "relisted", "donated", "dumped"],
  negotiating: ["listed", "negotiating", "scheduled", "relisted", "donated", "dumped"],
  scheduled: ["listed", "negotiating", "scheduled", "handed_off", "relisted", "donated", "dumped"],
  handed_off: ["paid"],
  relisted: ["negotiating", "scheduled", "handed_off", "donated", "dumped"],
  paid: [],
  donated: [],
  dumped: [],
};

export function canTransition(from: DealState, to: DealState): boolean {
  return from === to || NEXT[from].includes(to);
}

export class IllegalTransition extends Error {
  constructor(
    readonly from: DealState,
    readonly to: DealState,
  ) {
    super(`deal cannot go from ${from} to ${to}`);
  }
}

export function assertTransition(from: DealState, to: DealState): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}

export function isOpen(state: DealState): boolean {
  return state === "listed" || state === "negotiating" || state === "scheduled" || state === "relisted";
}
