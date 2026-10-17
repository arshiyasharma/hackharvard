import type { Slot } from "@elves/shared";

/** A recurring availability window in the move's time zone: these weekdays, from startHour to endHour. */
export interface Window {
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  startHour: number;
  endHour: number;
}

/** Weekday evenings and weekend middays, until the owner (or a roommate) says otherwise. */
export const DEFAULT_WINDOWS: Window[] = [
  { days: [1, 2, 3, 4, 5], startHour: 18, endHour: 20 },
  { days: [0, 6], startHour: 10, endHour: 14 },
];

export const DEFAULT_TZ = "America/New_York";

export interface CalendarInput {
  now: Date;
  /** Last moment a slot may start (move-out); defaults to a week out. */
  until?: Date | null;
  windows?: Window[];
  /** Slots already booked anywhere in the move: the calendar is shared. */
  booked?: Slot[];
  tz?: string;
  slotMinutes?: number;
  /** No slot sooner than this many hours from now. */
  leadHours?: number;
  /** Never look further out than this. */
  horizonDays?: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Wall-clock parts of an instant in `tz`. */
function parts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const get = (t: string) => f.formatToParts(d).find((p) => p.type === t)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  };
}

/** The instant at wall-clock y-m-d h:00 in `tz` (DST-safe to the hour). */
export function zonedInstant(y: number, m: number, d: number, h: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h);
  const p = parts(new Date(guess), tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return new Date(guess - (asIfUtc - guess));
}

export function slotLabel(start: Date, tz: string): string {
  const p = parts(start, tz);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${WEEKDAYS[p.weekday]} ${h12}${p.minute ? `:${String(p.minute).padStart(2, "0")}` : ""}${p.hour < 12 ? "am" : "pm"}`;
}

export function makeSlot(start: Date, minutes: number, tz: string): Slot {
  return {
    id: start.toISOString(),
    start: start.toISOString(),
    end: new Date(start.getTime() + minutes * 60_000).toISOString(),
    label: slotLabel(start, tz),
  };
}

function overlaps(a: Slot, b: Slot): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Every free slot from the windows, soonest first. */
export function openSlots(input: CalendarInput): Slot[] {
  const tz = input.tz ?? DEFAULT_TZ;
  const minutes = input.slotMinutes ?? 60;
  const windows = input.windows ?? DEFAULT_WINDOWS;
  const earliest = input.now.getTime() + (input.leadHours ?? 3) * 3_600_000;
  const horizon = input.now.getTime() + (input.horizonDays ?? 7) * 86_400_000;
  const until = Math.min(input.until ? input.until.getTime() : horizon, horizon);
  const booked = input.booked ?? [];
  const today = parts(input.now, tz);
  const out: Slot[] = [];
  for (let offset = 0; offset <= (input.horizonDays ?? 7); offset++) {
    const noon = zonedInstant(today.year, today.month, today.day, 12, tz).getTime() + offset * 86_400_000;
    const day = parts(new Date(noon), tz);
    for (const w of windows) {
      if (!w.days.includes(day.weekday)) continue;
      for (let h = w.startHour; h + minutes / 60 <= w.endHour; h += minutes / 60) {
        const start = zonedInstant(day.year, day.month, day.day, h, tz);
        if (start.getTime() < earliest || start.getTime() > until) continue;
        const slot = makeSlot(start, minutes, tz);
        if (!booked.some((b) => overlaps(b, slot))) out.push(slot);
      }
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** At most three slots, spread across different days when the calendar allows. */
export function offerSlots(input: CalendarInput, max = 3): Slot[] {
  const all = openSlots(input);
  const tz = input.tz ?? DEFAULT_TZ;
  const dayOf = (s: Slot) => {
    const p = parts(new Date(s.start), tz);
    return `${p.year}-${p.month}-${p.day}`;
  };
  const picked: Slot[] = [];
  const days = new Set<string>();
  for (const s of all) {
    if (picked.length >= max) break;
    if (!days.has(dayOf(s))) {
      picked.push(s);
      days.add(dayOf(s));
    }
  }
  for (const s of all) {
    if (picked.length >= max) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked.sort((a, b) => a.start.localeCompare(b.start));
}

export function isFree(slot: Slot, booked: Slot[]): boolean {
  return !booked.some((b) => b.id !== slot.id && overlaps(b, slot)) && !booked.some((b) => b.id === slot.id);
}

/** Move-out as an instant: the start of that day in the move's zone. */
export function moveOutInstant(moveOutAt: string | null, tz = DEFAULT_TZ): Date | null {
  const m = moveOutAt?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return zonedInstant(Number(m[1]), Number(m[2]), Number(m[3]), 0, tz);
}
