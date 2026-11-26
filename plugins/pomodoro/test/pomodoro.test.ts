import { describe, expect, test } from "bun:test";
import { createPlugin } from "../src/index";
import { START, alertOf, buildCard, endMessage, clock, dayKey, lengths, prune, readDays, readState, remaining, settle, skip, toggle, type State } from "../src/lib";

const MIN = 60_000;
const len = lengths({});
const at = (day: number, h: number, m = 0, s = 0) => new Date(2026, 10, day, h, m, s).getTime();

describe("the timer", () => {
  test("lengths come from the settings, 1 to 180 minutes", () => {
    expect(len).toEqual({ focus: 25 * MIN, break: 5 * MIN });
    expect(lengths({ focus: 50, break: 10 })).toEqual({ focus: 50 * MIN, break: 10 * MIN });
    expect(lengths({ focus: 0, break: "x" })).toEqual({ focus: 25 * MIN, break: 5 * MIN });
    expect(lengths({ focus: 999 }).focus).toBe(180 * MIN);
  });
  test("start, pause, resume keep the time that is left", () => {
    const t0 = at(25, 9);
    const running = toggle(START, len, t0);
    expect(remaining(running, len, t0 + 10 * MIN).left).toBe(15 * MIN);
    const paused = toggle(running, len, t0 + 10 * MIN);
    expect(remaining(paused, len, t0 + 3 * 60 * MIN).left).toBe(15 * MIN);
    const again = toggle(paused, len, t0 + 3 * 60 * MIN);
    expect(remaining(again, len, t0 + 3 * 60 * MIN + 5 * MIN)).toEqual({ left: 10 * MIN, total: 25 * MIN });
  });
  test("a block that ended while nobody looked counts once, on the day it ended", () => {
    const running = toggle(START, len, at(25, 23, 30));
    const first = settle(running, {}, at(26, 8));
    expect(first.state).toEqual({ phase: "break", status: "ready" });
    expect(first.days).toEqual({ "2026-11-25": 1 });
    expect(settle(first.state, first.days, at(26, 9)).days).toEqual({ "2026-11-25": 1 });
  });
  test("a break and a skipped block do not count", () => {
    const brk = toggle(skip(START), len, at(25, 9));
    expect(brk.phase).toBe("break");
    expect(settle(brk, {}, at(25, 10))).toMatchObject({ days: {}, state: { phase: "focus", status: "ready" } });
    expect(skip(toggle(START, len, at(25, 9)))).toEqual({ phase: "break", status: "ready" });
  });
  test("the last 30 days are kept", () => {
    const days: Record<string, number> = {};
    for (let i = 0; i < 45; i++) days[dayKey(new Date(2026, 10, 25 - i, 12).getTime())] = 1;
    const kept = Object.keys(prune(days, at(25, 18))).sort();
    expect(kept).toHaveLength(30);
    expect([kept[0], kept.at(-1)]).toEqual(["2026-10-27", "2026-11-25"]);
  });
  test("damaged storage starts over", () => {
    for (const v of [null, 5, "x", [], { phase: "nap" }]) expect(readState(v)).toEqual(START);
    expect(readState({ phase: "break", status: "running" })).toEqual({ phase: "break", status: "ready" });
    expect(readDays({ "2026-11-25": 2, junk: 1, "2026-11-24": -1 })).toEqual({ "2026-11-25": 2 });
  });
  test("the clock rounds up", () => {
    expect([clock(25 * MIN), clock(24 * MIN + 59_001), clock(1), clock(0), clock(120 * MIN)]).toEqual(["25:00", "25:00", "00:01", "00:00", "120:00"]);
  });
  test("the ring shows the time left and how far the phase is", () => {
    const running = toggle(START, len, at(25, 9));
    const root = buildCard(running, { "2026-11-25": 3 }, len, at(25, 9, 10), { w: 2, h: 2 }).root as any;
    expect(root.children[0]).toEqual({ t: "ring", value: 0.4, tone: "accent", text: "15:00", size: "l", label: "Focus · 3 today" });
    const paused = buildCard({ phase: "break", status: "paused", left: MIN, total: 5 * MIN }, {}, len, at(25, 9), { w: 2, h: 2 }).root as any;
    expect(paused.children[0]).toMatchObject({ value: 0.8, tone: "muted", text: "01:00", label: "Paused · 0 today" });
    expect((buildCard(toggle(skip(START), len, at(25, 9)), {}, len, at(25, 9)).root as any).children[0].tone).toBe("ok");
  });
  test("the main button says what it will do and stands out", () => {
    const find = (s: State) => JSON.stringify(buildCard(s, {}, len, at(25, 9), { w: 2, h: 2 }));
    expect(find(START)).toContain('"label":"Start","action":"toggle","tone":"accent","active":true');
    expect(find(toggle(START, len, at(25, 9)))).toContain('"label":"Pause","action":"toggle"');
    const resting: State = { phase: "break", status: "paused", left: MIN, total: 5 * MIN };
    expect(find(resting)).toContain('"label":"Resume","action":"toggle","tone":"ok"');
    expect(JSON.stringify(buildCard(resting, {}, len, at(25, 9), { w: 4, h: 2 }))).toContain('"label":"Resume","icon":"player-play"');
  });
  test("the tile's size chooses where the ring goes", () => {
    const build = (w: number, h: number) => buildCard(START, { "2026-11-25": 3 }, len, at(25, 9), { w, h }).root as any;
    expect([build(2, 2).t, build(2, 1).t, build(4, 2).t]).toEqual(["col", "row", "row"]);
    for (const [w, h] of [[2, 1], [2, 2], [4, 2]] as const) {
      const json = JSON.stringify(build(w, h));
      for (const action of h === 1 ? ["toggle", "skip"] : ["toggle", "skip", "reset"]) expect(json).toContain(`"action":"${action}"`);
      expect(json).toContain(h === 1 ? '"text":"Focus"' : "3 today");
    }
    expect(build(2, 1).children[1].children).toHaveLength(2);
    expect(JSON.stringify(build(4, 2))).toContain('"t":"pill","text":"Focus"');
    expect((buildCard(START, {}, len, at(25, 9)).root as any).t).toBe("col");
  });
  test("any tile wider than it is high puts the ring on the left (3x1, 3x2, 4x1 too)", () => {
    const build = (w: number, h: number) => buildCard(START, {}, len, at(25, 9), { w, h }).root as any;
    expect([build(3, 1).t, build(3, 2).t, build(4, 1).t, build(2, 2).t]).toEqual(["row", "row", "row", "col"]);
  });
  test("the end of a phase: what the phones are told, and the settings", () => {
    expect(endMessage("focus")).toEqual({ title: "Focus block done", body: "Time for a break" });
    expect(endMessage("break").title).toBe("Break is over");
    expect(alertOf({})).toEqual({ notify: true, sound: null });
    expect(alertOf({ notify: false, sound: "chime" })).toEqual({ notify: false, sound: "chime" });
    expect(alertOf({ sound: "none" }).sound).toBeNull();
    expect(alertOf({ sound: "siren" }).sound).toBeNull();
  });
});

/** The plugin against a fake agent with its own clock. `store` outlives a restart, like the plugin's data file. */
function harness(store = new Map<string, unknown>(), clockRef = { now: at(25, 9) }, extra: { settings?: Record<string, unknown>; notify?: boolean } = {}) {
  const pushes: any[] = [];
  const notes: Array<[string, any]> = [];
  const acts: Record<string, (s: any) => any> = {};
  let provide: (tile?: { w: number; h: number }) => Promise<any> = async () => null;
  let tick: (() => void) | null = null;
  const plugin = createPlugin({ now: () => clockRef.now, every: (fn) => { tick = fn; return () => { tick = null; }; } });
  void plugin.activate({
    id: "dev.nookdeck.pomodoro", log: () => {},
    settings: { get: () => ({ focus: 25, break: 5, ...extra.settings }) },
    ...(extra.notify === false ? {} : { notify: async (title: string, o: any) => { notes.push([title, o]); } }),
    storage: { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: unknown) => { store.set(k, structuredClone(v)); } },
    net: { fetch: async () => { throw new Error("no network"); } },
    widgets: { provide: (_id: string, fn: any) => { provide = (tile) => fn({}, tile ?? { w: 2, h: 2 }); }, push: (_id: string, u: any) => pushes.push(typeof u === "function" ? { wide: u({ w: 4, h: 2 }), square: u({ w: 2, h: 2 }) } : u) },
    actions: { handle: (id: string, fn: any) => { acts[id] = fn; } },
  } as any);
  const settleTicks = () => new Promise((r) => setTimeout(r, 5));
  return {
    store, clockRef, pushes, plugin, notes,
    act: (id: string) => acts[id]!({}),
    card: async () => JSON.stringify((await provide()).data),
    ticking: () => tick !== null,
    tick: async () => { tick?.(); await settleTicks(); },
  };
}

describe("the plugin", () => {
  test("it ticks every second only while a phase runs", async () => {
    const h = harness();
    await h.card();
    expect(h.ticking()).toBe(false);
    await h.act("toggle");
    expect(h.ticking()).toBe(true);
    h.clockRef.now += 1000;
    await h.tick();
    expect(h.pushes.at(-1).square.data.root.t).toBe("col");
    expect(h.pushes.at(-1).wide.data.root.t).toBe("row");
    expect(JSON.stringify(h.pushes.at(-1))).toContain('"text":"24:59"');
    await h.act("toggle");
    expect(h.ticking()).toBe(false);
  });

  test("keeps time when its process was stopped while the phone slept, and counts the block once", async () => {
    const a = harness();
    await a.act("toggle");
    a.plugin.deactivate!();
    a.clockRef.now += 40 * MIN;
    const b = harness(a.store, a.clockRef);
    const card = await b.card();
    expect(card).toContain('"label":"Break · 1 today"');
    expect(card).toContain('1 today"');
    expect(await b.card()).toContain('1 today"');
    expect(b.ticking()).toBe(false);
  });

  test("resumes ticking after a restart in the middle of a block", async () => {
    const a = harness();
    await a.act("toggle");
    a.plugin.deactivate!();
    a.clockRef.now += 10 * MIN;
    const b = harness(a.store, a.clockRef);
    expect(await b.card()).toContain('"text":"15:00"');
    expect(b.ticking()).toBe(true);
  });

  test("ticks, polls and taps together count a finished block once", async () => {
    const h = harness();
    await h.act("toggle");
    h.clockRef.now += 25 * MIN + 10_000;
    await Promise.all([h.card(), h.card(), h.tick(), h.act("reset")]);
    expect(h.store.get("days")).toEqual({ "2026-11-25": 1 });
  });

  test("a tap just as the time runs out does not start the break", async () => {
    const h = harness();
    await h.act("toggle");
    h.clockRef.now += 25 * MIN + 500;
    await h.act("toggle");
    expect(h.store.get("timer")).toEqual({ phase: "break", status: "ready" });
    await h.act("toggle");
    expect(h.store.get("timer")).toMatchObject({ phase: "break", status: "running" });
  });
});

describe("telling the phones", () => {
  test("a phase that runs out is announced once, with the chosen sound", async () => {
    const h = harness(undefined, undefined, { settings: { sound: "soft" } });
    await h.act("toggle");
    h.clockRef.now += 25 * MIN + 1000;
    await h.tick();
    await h.tick();
    await h.card();
    expect(h.notes).toEqual([["Focus block done", { body: "Time for a break", sound: "soft" }]]);
  });
  test("no sound by default; nothing when turned off, when the permission is missing, or when it ended long ago", async () => {
    const plain = harness();
    await plain.act("toggle");
    plain.clockRef.now += 25 * MIN;
    await plain.tick();
    expect(plain.notes).toEqual([["Focus block done", { body: "Time for a break" }]]);

    const off = harness(undefined, undefined, { settings: { notify: false, sound: "chime" } });
    await off.act("toggle");
    off.clockRef.now += 25 * MIN;
    await off.tick();
    expect(off.notes).toEqual([]);

    const old = harness();
    await old.act("toggle");
    old.clockRef.now += 25 * MIN + 3 * MIN; // the computer slept through the end
    await old.card();
    expect(old.notes).toEqual([]);
    expect(await old.card()).toContain("1 today"); // still counted

    const noPerm = harness(undefined, undefined, { notify: false });
    await noPerm.act("toggle");
    noPerm.clockRef.now += 25 * MIN;
    await noPerm.tick();
    expect(noPerm.ticking()).toBe(false);
  });
});
