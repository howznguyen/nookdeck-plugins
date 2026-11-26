import { describe, expect, test } from "bun:test";
import { CHECK_MS, createPlugin } from "../src/index";
import { add, buildCard, config, dayKey, due, hhmm, history, inHours, readSaved, type Saved } from "../src/lib";

const MIN = 60_000;
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();
const empty: Saved = { days: {}, lastAt: 0 };
const c = config({});

describe("counting", () => {
  test("settings: defaults, limits, HH:MM", () => {
    expect(c).toEqual({ goal: 8, every: 60, from: 540, to: 1260, sound: null });
    expect(config({ goal: 0, every: -5, from: "7:15", to: "25:00", sound: "soft" })).toEqual({ goal: 1, every: 0, from: 435, to: 1260, sound: "soft" });
    expect(hhmm("24:00", 0)).toBe(1440);
    expect(hhmm("nine", 7)).toBe(7);
  });
  test("+1 and -1 count today only; never below 0; a new day starts at 0", () => {
    let s = add(add(add(empty, 1, at(27, 9)), 1, at(27, 10)), -1, at(27, 11));
    expect(s.days).toEqual({ "2026-11-27": 1 });
    s = add(add(s, -1, at(27, 12)), -1, at(27, 12));
    expect(s.days).toEqual({});
    s = add(add(empty, 1, at(27, 23, 59)), 1, at(28, 0, 1));
    expect(s.days).toEqual({ "2026-11-27": 1, "2026-11-28": 1 });
  });
  test("history: 7 days, oldest first; 30 days kept; damaged storage is read as empty", () => {
    const days: Record<string, number> = {};
    for (let i = 0; i < 40; i++) days[dayKey(new Date(2026, 10, 27 - i, 12).getTime())] = i + 1;
    const s = add({ days, lastAt: 0 }, 1, at(27, 9));
    expect(Object.keys(s.days).length).toBe(30);
    expect(history(s, at(27, 9))).toEqual([7, 6, 5, 4, 3, 2, 2]);
    expect(readSaved({ days: { x: 3, "2026-11-27": -1, "2026-11-26": 2 }, lastAt: "no" })).toEqual({ days: { "2026-11-26": 2 }, lastAt: 0 });
    expect(readSaved(null)).toEqual(empty);
  });
});

describe("reminders", () => {
  test("only within the hours, under the goal, and `every` minutes after the last glass or reminder", () => {
    const s = add(empty, 1, at(27, 9));
    expect(due(s, c, at(27, 9, 59))).toBe(false);
    expect(due(s, c, at(27, 10))).toBe(true);
    expect(due(s, c, at(27, 21, 30))).toBe(false); // after 21:00
    expect(due(empty, c, at(27, 8, 59))).toBe(false); // before 09:00
    expect(due(empty, { ...c, every: 0 }, at(27, 12))).toBe(false);
    const full: Saved = { days: { "2026-11-27": 8 }, lastAt: 0 };
    expect(due(full, c, at(27, 12))).toBe(false);
  });
  test("hours over midnight", () => {
    const night = config({ from: "22:00", to: "02:00" });
    expect([inHours(night, at(27, 23)), inHours(night, at(28, 1)), inHours(night, at(28, 3))]).toEqual([true, true, false]);
  });
});

describe("the tile", () => {
  const walk = (n: any, f: (n: any) => void) => { f(n); for (const x of n?.children ?? []) walk(x, f); };
  const parts = (d: any) => { const out: any[] = []; walk(d.root, (n) => out.push(n)); return out; };
  test("1x1 is one +1 button with the count; 2x2 a ring over -1 and +1; 4x2 adds the week", () => {
    const s = add(add(empty, 1, at(27, 9)), 1, at(27, 10));
    expect(buildCard(s, c, at(27, 11), { w: 1, h: 1 }).root).toMatchObject({ t: "button", label: "2/8", action: "add" });
    const sq = parts(buildCard(s, c, at(27, 11), { w: 2, h: 2 }));
    expect(sq.filter((n) => n.t === "button").map((n) => n.action)).toEqual(["remove", "add"]);
    expect(sq.find((n) => n.t === "ring")).toMatchObject({ text: "2/8", value: 0.25, label: "2 of 8" });
    expect(parts(buildCard(s, c, at(27, 11), { w: 4, h: 2 })).some((n) => n.t === "sparkline")).toBe(true);
    expect((buildCard(s, c, at(27, 11), { w: 2, h: 1 }).root as any).t).toBe("row");
  });
  test("a due reminder shows on the tile; the goal shows as done", () => {
    expect(parts(buildCard(empty, c, at(27, 11), { w: 2, h: 2 }, true)).find((n) => n.t === "ring")).toMatchObject({ tone: "warn", label: "Time to drink" });
    const full: Saved = { days: { "2026-11-27": 8 }, lastAt: 0 };
    expect(parts(buildCard(full, c, at(27, 11), { w: 2, h: 2 }, true)).find((n) => n.t === "ring")).toMatchObject({ tone: "ok", label: "Goal reached", value: 1 });
  });
});

/** The plugin with a fake agent and its own clock. */
function harness(settings: Record<string, unknown> = {}, o: { notify?: boolean; now?: number } = {}) {
  const store = new Map<string, unknown>();
  const clock = { now: o.now ?? at(27, 9) };
  const notes: Array<[string, any]> = [];
  const pushes: Record<string, any> = {};
  const acts: Record<string, () => Promise<void>> = {};
  let check: (() => void) | null = null;
  let every = 0;
  createPlugin({ now: () => clock.now, every: (fn, ms) => { check = fn; every = ms; return () => { check = null; }; } }).activate({
    id: "dev.nookdeck.water", log: () => {},
    settings: { get: () => settings },
    storage: { get: async (k: string) => structuredClone(store.get(k) ?? null), set: async (k: string, v: unknown) => { store.set(k, structuredClone(v)); } },
    ...(o.notify === false ? {} : { notify: async (t: string, x: any) => { notes.push([t, x]); } }),
    widgets: { provide: () => {}, push: async (id: string, u: any) => { pushes[id] = typeof u === "function" ? await u({ w: 2, h: 2 }, {}) : u; } },
    actions: { handle: (id: string, fn: any) => { acts[id] = () => fn({}); } },
  } as any);
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { store, clock, notes, pushes, acts, get every() { return every; }, check: async () => { check?.(); await settle(); await settle(); } };
}

describe("the plugin", () => {
  test("checks once a minute; reminds when due with the chosen sound, once per interval; a glass restarts the wait", async () => {
    const h = harness({ sound: "chime" });
    expect(h.every).toBe(CHECK_MS);
    await h.check(); // 09:00, nothing drunk, never reminded: due at once
    expect(h.notes).toEqual([["Time for a glass of water", { body: "0 of 8 today", sound: "chime" }]]);
    expect(JSON.stringify(h.pushes.today)).toContain("Time to drink");
    h.clock.now += 30 * MIN;
    await h.check();
    expect(h.notes.length).toBe(1);
    await h.acts.add!();
    expect(JSON.stringify(h.pushes.today)).toContain("1 of 8");
    h.clock.now += 59 * MIN;
    await h.check();
    expect(h.notes.length).toBe(1);
    h.clock.now += MIN;
    await h.check();
    expect(h.notes.length).toBe(2);
    expect(h.notes[1]![1]).toEqual({ body: "1 of 8 today", sound: "chime" });
    expect(h.pushes.week).toMatchObject({ render: "chart", data: { points: [0, 0, 0, 0, 0, 0, 1] } });
  });
  test("without the notify permission the tile alone says it is time; midnight resets the count", async () => {
    const h = harness({}, { notify: false, now: at(27, 20) });
    await h.check();
    expect(h.notes).toEqual([]);
    expect(JSON.stringify(h.pushes.today)).toContain("Time to drink");
    await h.acts.add!();
    h.clock.now = at(28, 0, 5);
    await h.check();
    expect(JSON.stringify(h.pushes.today)).toContain("0 of 8");
    expect(h.pushes.week.data.points.slice(-2)).toEqual([1, 0]);
  });
});
