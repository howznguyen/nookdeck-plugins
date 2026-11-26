/**
 * Glasses of water per day, and when to remind. No clock and no storage of its own: every function gets `now`, so it can be tested
 * and stays right across restarts. Days are the computer's local days, so the count starts again at midnight by itself.
 */
import type { CardData, CardNode } from "@nookdeck/plugin";

/** Glasses per local day, "YYYY-MM-DD". */
export type Days = Record<string, number>;
export interface Saved { days: Days; /** the last glass or the last reminder, ms; reminders count from it */ lastAt: number }

export const KEEP_DAYS = 30;
export const HISTORY_DAYS = 7;
export const MAX_PER_DAY = 40;
export const SOUNDS = ["none", "chime", "soft", "birds"] as const;

export interface Config {
  goal: number;
  /** minutes between reminders; 0 = no reminders */
  every: number;
  /** reminder hours, minutes since midnight: from <= t < to */
  from: number;
  to: number;
  sound: "chime" | "soft" | "birds" | null;
}

const int = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** "09:30" -> 570; anything else -> the fallback. */
export function hhmm(v: unknown, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return fallback;
  const h = Number(m[1]), min = Number(m[2]);
  return h <= 24 && min < 60 && h * 60 + min <= 1440 ? h * 60 + min : fallback;
}

export function config(s: Record<string, unknown>): Config {
  const sound = s.sound === "chime" || s.sound === "soft" || s.sound === "birds" ? s.sound : null;
  return { goal: int(s.goal, 8, 1, MAX_PER_DAY), every: int(s.every, 60, 0, 600), from: hhmm(s.from, 9 * 60), to: hhmm(s.to, 21 * 60), sound };
}

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const dayBefore = (ms: number, n: number): number => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, 12).getTime(); };

export function readSaved(v: any): Saved {
  const days: Days = {};
  if (v && typeof v.days === "object" && v.days && !Array.isArray(v.days)) {
    for (const [k, n] of Object.entries(v.days)) if (/^\d{4}-\d\d-\d\d$/.test(k) && typeof n === "number" && Number.isFinite(n) && n > 0) days[k] = Math.min(MAX_PER_DAY, Math.round(n));
  }
  return { days, lastAt: typeof v?.lastAt === "number" && Number.isFinite(v.lastAt) ? v.lastAt : 0 };
}

/** Keeps today and the 29 days before it. */
export function prune(days: Days, now: number): Days {
  const oldest = dayKey(dayBefore(now, KEEP_DAYS - 1));
  return Object.fromEntries(Object.entries(days).filter(([k]) => k >= oldest));
}

export const today = (s: Saved, now: number): number => s.days[dayKey(now)] ?? 0;

/** One glass more (+1) or fewer (-1) today. A glass also restarts the reminder wait. */
export function add(s: Saved, delta: 1 | -1, now: number): Saved {
  const key = dayKey(now);
  const n = Math.min(MAX_PER_DAY, Math.max(0, (s.days[key] ?? 0) + delta));
  const days = { ...s.days };
  if (n) days[key] = n; else delete days[key];
  return { days: prune(days, now), lastAt: delta > 0 ? now : s.lastAt };
}

/** The last 7 days, oldest first, today last. */
export function history(s: Saved, now: number): number[] {
  return Array.from({ length: HISTORY_DAYS }, (_, i) => s.days[dayKey(dayBefore(now, HISTORY_DAYS - 1 - i))] ?? 0);
}

const minuteOfDay = (ms: number): number => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
export function inHours(c: Config, now: number): boolean {
  const m = minuteOfDay(now);
  return c.from <= c.to ? m >= c.from && m < c.to : m >= c.from || m < c.to; // a window over midnight, such as 22:00-02:00
}

/** Time for a reminder: reminders on, within the hours, the goal not reached, and `every` minutes since the last glass or reminder. */
export function due(s: Saved, c: Config, now: number): boolean {
  return c.every > 0 && inHours(c, now) && today(s, now) < c.goal && now - s.lastAt >= c.every * 60_000;
}

export function reminder(s: Saved, c: Config, now: number): { title: string; body: string } {
  const n = today(s, now);
  return { title: "Time for a glass of water", body: `${n} of ${c.goal} today` };
}

// ---------------------------------------------------------------- the tile

export interface Tile { w: number; h: number }
const btn = (label: string, action: string, o: Record<string, unknown> = {}): CardNode => ({ t: "button", label, action, layout: "tile", ...o }) as CardNode;

/**
 * A ring that fills toward the goal with the count in the middle, +1 and -1. Wider tiles add the last 7 days. While a reminder is
 * due the ring turns to the warning colour and says so, so a phone that missed the notification still shows it.
 */
export function buildCard(s: Saved, c: Config, now: number, tile: Tile = { w: 2, h: 2 }, wanted = false): CardData {
  const n = today(s, now);
  const done = n >= c.goal;
  const tone = done ? "ok" : wanted ? "warn" : "accent";
  const label = done ? "Goal reached" : wanted ? "Time to drink" : `${n} of ${c.goal}`;
  const ring = { t: "ring", value: Math.min(1, n / c.goal), tone, text: `${n}/${c.goal}`, size: "l" } as unknown as CardNode;
  const plus = btn("+1", "add", { icon: "plus", tone, active: true });
  const minus = btn("-1", "remove", { icon: "minus" });
  if (tile.w * tile.h <= 1) return { root: btn(`${n}/${c.goal}`, "add", { icon: "plus", tone, active: true }) } as CardData; // 1x1: one big +1 that shows the count
  const week = history(s, now);
  const chart = tile.w >= 4 && tile.h >= 2 && ({ t: "col", gap: 1, grow: true, children: [
    { t: "text", text: "Last 7 days", size: "s", tone: "muted" },
    { t: "sparkline", points: week, tone: "accent" },
    { t: "text", text: `${week.filter((x) => x >= c.goal).length} of 7 days at the goal`, size: "s", tone: "muted" },
  ] } as unknown as CardNode);
  if (tile.w > tile.h) {
    return { root: { t: "row", gap: 2, children: [
      { ...(ring as any), label },
      { t: "col", gap: 1, grow: true, children: [{ t: "row", gap: 1, grow: true, children: [minus, plus] }] },
      chart,
    ].filter(Boolean) } } as CardData;
  }
  return { root: { t: "col", gap: 1, children: [{ ...(ring as any), label }, { t: "row", gap: 1, children: [minus, plus] }] } } as CardData;
}
