/**
 * The timer, with no clock and no storage of its own: every function gets `now`. A running phase is kept as the time it ENDS, so
 * it stays right however long nobody asks: the phone asleep, the plugin's process stopped for being idle, or the computer asleep.
 */
export type Phase = "focus" | "break";
export type State =
  | { phase: Phase; status: "ready" }
  | { phase: Phase; status: "running"; endsAt: number; total: number }
  | { phase: Phase; status: "paused"; left: number; total: number };
/** Finished focus blocks per local day, "YYYY-MM-DD". */
export type Days = Record<string, number>;
export interface Lengths { focus: number; break: number }

export const KEEP_DAYS = 30;
export const START: State = { phase: "focus", status: "ready" };

const minutes = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(180, Math.round(n)) : fallback;
};

/** The two phase lengths in ms, from the plugin's settings: 1 to 180 minutes. */
export const lengths = (s: Record<string, unknown>): Lengths => ({ focus: minutes(s.focus, 25) * 60_000, break: minutes(s.break, 5) * 60_000 });

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Keeps today and the 29 days before it. */
export function prune(days: Days, now: number): Days {
  const d = new Date(now);
  const oldest = dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (KEEP_DAYS - 1), 12).getTime());
  return Object.fromEntries(Object.entries(days).filter(([k]) => k >= oldest));
}

const isPhase = (v: unknown): v is Phase => v === "focus" || v === "break";
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** What storage gave back, or a fresh timer when it is missing or damaged. */
export function readState(v: any): State {
  if (!v || !isPhase(v.phase)) return START;
  if (v.status === "running" && positive(v.endsAt) && positive(v.total)) return { phase: v.phase, status: "running", endsAt: v.endsAt, total: v.total };
  if (v.status === "paused" && positive(v.left) && positive(v.total)) return { phase: v.phase, status: "paused", left: v.left, total: v.total };
  return { phase: v.phase, status: "ready" };
}

export function readDays(v: unknown): Days {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([k, n]) => /^\d{4}-\d\d-\d\d$/.test(k) && positive(n))) as Days;
}

const other = (p: Phase): Phase => (p === "focus" ? "break" : "focus");

/**
 * Closes a phase whose time is up. The next one waits for Start. A finished focus block counts once, on the day it ENDED,
 * however late this is called.
 */
export function settle(state: State, days: Days, now: number): { state: State; days: Days; finished: number | null } {
  if (state.status !== "running" || state.endsAt > now) return { state, days, finished: null };
  let next = days;
  if (state.phase === "focus") {
    const key = dayKey(state.endsAt);
    next = prune({ ...days, [key]: (days[key] ?? 0) + 1 }, now);
  }
  return { state: { phase: other(state.phase), status: "ready" }, days: next, finished: state.endsAt };
}

export function toggle(state: State, len: Lengths, now: number): State {
  if (state.status === "running") return { phase: state.phase, status: "paused", left: Math.max(1, state.endsAt - now), total: state.total };
  const total = state.status === "paused" ? state.total : len[state.phase];
  const left = state.status === "paused" ? state.left : total;
  return { phase: state.phase, status: "running", endsAt: now + left, total };
}

/** To the other phase, waiting for Start. A skipped focus block does not count. */
export const skip = (state: State): State => ({ phase: other(state.phase), status: "ready" });
/** This phase again, from the top. */
export const reset = (state: State): State => ({ phase: state.phase, status: "ready" });

export function remaining(state: State, len: Lengths, now: number): { left: number; total: number } {
  if (state.status === "running") return { left: Math.max(0, state.endsAt - now), total: state.total };
  if (state.status === "paused") return { left: state.left, total: state.total };
  return { left: len[state.phase], total: len[state.phase] };
}

/** 24:59. Rounded up, so a full phase reads 25:00 and 00:00 only shows when it is over. */
export function clock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** A tile's size in grid cells. */
export interface Tile { w: number; h: number }

/** What the phones are told when a phase ends: the phase that just ended decides the words. */
export function endMessage(ended: Phase): { title: string; body: string } {
  return ended === "focus" ? { title: "Focus block done", body: "Time for a break" } : { title: "Break is over", body: "Ready for the next focus block" };
}

export const SOUNDS = ["none", "chime", "soft", "birds"] as const;
export type Sound = (typeof SOUNDS)[number];
/** How the end of a phase is announced, from the settings: a notification (on by default) with an optional sound (off by default). */
export function alertOf(s: Record<string, unknown>): { notify: boolean; sound: Exclude<Sound, "none"> | null } {
  const sound = (SOUNDS as readonly string[]).includes(String(s.sound)) && s.sound !== "none" ? (s.sound as Exclude<Sound, "none">) : null;
  return { notify: s.notify !== false, sound };
}
/** A phase that ended longer ago than this (the computer slept, Nookdeck was off) is counted but not announced. */
export const ANNOUNCE_WITHIN_MS = 2 * 60_000;

/**
 * The timer as a ring: the time left in the middle, the arc filling as the phase runs. A tile wider than it is high has the ring on
 * the left and the controls beside it; a square or tall one has the ring on top. Without a size (the preview, an older Nookdeck) it
 * takes the square one.
 */
export function buildCard(state: State, days: Days, len: Lengths, now: number, tile?: Tile) {
  const { left, total } = remaining(state, len, now);
  const tone = state.phase === "focus" ? "accent" : "ok";
  const running = state.status === "running";
  const paused = state.status === "paused";
  const phase = state.phase === "focus" ? "Focus" : "Break";
  const count = `${days[dayKey(now)] ?? 0} today`;
  // "Paused" stands in for the phase's name: both together do not fit. The main button keeps the phase's colour.
  const name = paused ? "Paused" : phase;
  const said = `${name} · ${count}`;
  const ring = {
    t: "ring", value: Math.round(Math.min(1, Math.max(0, 1 - left / total)) * 1000) / 1000,
    tone: paused ? "muted" : tone, text: clock(left), size: "l",
  };
  const icon = running ? "player-pause" : "player-play";
  // filled in the phase's colour both ways, so it is the one button that stands out
  const main = (label: string, withIcon = true) => ({ t: "button", label, ...(withIcon ? { icon } : {}), action: "toggle", tone, active: true });
  // "Resume" in the middle of a block, "Start" only for a fresh one
  const word = running ? "Pause" : paused ? "Resume" : "Start";
  const reset = { t: "button", label: "", icon: "refresh", action: "reset" };
  const skipIt = { t: "button", label: "", icon: "player-skip-forward", action: "skip" };

  if (!tile || tile.w <= tile.h) {
    return { root: { t: "col", gap: 1, children: [
      { ...ring, label: said },
      // between two icon buttons there is room for the word or an icon, not both
      { t: "row", gap: 1, children: [reset, main(word, false), skipIt] },
    ] } };
  }
  const side = tile.h <= 1
    // one row high: two short lines beside the ring, with room for the phase's name and two buttons
    ? [{ t: "text", text: name, size: "s", tone: "muted" }, { t: "row", gap: 1, children: [main(""), skipIt] }]
    : [
        { t: "row", gap: 1, align: "between", children: [{ t: "pill", text: name, tone }, { t: "text", text: count, size: "s", tone: "muted" }] },
        { t: "row", children: [main(word)] },
        { t: "row", gap: 1, children: [
          { t: "button", label: "Reset", action: "reset" },
          { t: "button", label: "Skip", action: "skip" },
        ] },
      ];
  return { root: { t: "row", gap: 2, children: [ring, { t: "col", gap: 1, grow: true, children: side }] } };
}
