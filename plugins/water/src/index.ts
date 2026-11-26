import type { PluginContext, PluginModule, Settings } from "@nookdeck/plugin";
import { add, buildCard, config, due, history, inHours, readSaved, reminder, type Saved, type Tile } from "./lib";

const KEY = "water";
/** How often the reminder time is checked, and the tile redrawn (it also turns over at midnight). */
export const CHECK_MS = 60_000;

export interface Env {
  now: () => number;
  every: (fn: () => void, ms: number) => () => void;
}
const real: Env = {
  now: Date.now,
  every: (fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
};

export function createPlugin(env: Env = real): PluginModule {
  let stop: (() => void) | null = null;
  return {
    activate(ctx: PluginContext) {
      // one at a time: a tap and a check must never lose a glass
      let queue: Promise<unknown> = Promise.resolve();
      const locked = <T>(fn: () => Promise<T>): Promise<T> => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
      const load = async (): Promise<Saved> => readSaved(await ctx.storage.get(KEY));
      const save = (s: Saved) => ctx.storage.set(KEY, s);
      const cfg = () => config(ctx.settings.get());
      /** a reminder went out and nothing was drunk since: the tile says so until the next glass */
      let wanted = false;

      const card = (s: Saved, tile?: Tile) => ({ render: "card" as const, data: buildCard(s, cfg(), env.now(), tile, wanted) });
      const pushAll = (s: Saved) => {
        ctx.widgets.push("today", (tile: Tile) => card(s, tile));
        ctx.widgets.push("week", { render: "chart", data: { points: history(s, env.now()), label: "Glasses, last 7 days", unit: "glasses" } });
      };

      const check = () => locked(async () => {
        const s = await load();
        const c = cfg();
        if (due(s, c, env.now())) {
          const next = { ...s, lastAt: env.now() };
          await save(next);
          wanted = true;
          const m = reminder(next, c, env.now());
          // without the notify permission (or on an older Nookdeck) the tile alone shows it is time
          if (ctx.notify) await ctx.notify(m.title, { body: m.body, ...(c.sound ? { sound: c.sound } : {}) }).catch((e: unknown) => ctx.log("notify failed:", e instanceof Error ? e.message : e));
          pushAll(next);
          return;
        }
        if (!inHours(c, env.now())) wanted = false; // the reminder hours are over: the tile calms down
        pushAll(s); // the count turns over at midnight with no tap
      });

      ctx.widgets.provide("today", (_s: Settings, tile?: Tile) => locked(async () => card(await load(), tile)), { every: 300 });
      ctx.widgets.provide("week", () => locked(async () => ({ render: "chart" as const, data: { points: history(await load(), env.now()), label: "Glasses, last 7 days", unit: "glasses" } })), { every: 3600 });

      const change = (delta: 1 | -1) => () => locked(async () => {
        const next = add(await load(), delta, env.now());
        await save(next);
        if (delta > 0) wanted = false;
        pushAll(next);
      });
      ctx.actions.handle("add", change(1));
      ctx.actions.handle("remove", change(-1));

      stop = env.every(() => void check().catch((e) => ctx.log("check failed:", e instanceof Error ? e.message : e)), CHECK_MS);
    },
    deactivate() { stop?.(); stop = null; },
  };
}

export default createPlugin();
