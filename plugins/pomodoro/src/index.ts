import type { PluginContext, PluginModule } from "@nookdeck/plugin";
import { ANNOUNCE_WITHIN_MS, alertOf, buildCard, endMessage, lengths, readDays, readState, reset, settle, skip, toggle, type Days, type Lengths, type State, type Tile } from "./lib";

/** A tap that arrives just after the phase ran out was meant for the old card: it must not start the next phase. */
export const LATE_TAP_MS = 2_000;

export interface Env {
  now: () => number;
  every: (fn: () => void, ms: number) => () => void;
}
const real: Env = {
  now: Date.now,
  every: (fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
};

export function createPlugin(env: Env = real): PluginModule {
  let stopTick: (() => void) | null = null;
  const stop = () => { stopTick?.(); stopTick = null; };

  return {
    activate(ctx: PluginContext) {
      // one at a time: a tick, a poll and a tap must never count a block twice or overwrite each other
      let queue: Promise<unknown> = Promise.resolve();
      const locked = <T>(fn: () => Promise<T>): Promise<T> => {
        const next = queue.then(fn);
        queue = next.catch(() => {});
        return next;
      };
      const len = (): Lengths => lengths(ctx.settings.get());

      async function load(): Promise<{ state: State; days: Days; finished: number | null }> {
        const [s, d] = await Promise.all([ctx.storage.get("timer"), ctx.storage.get("days")]);
        const before = readState(s);
        const out = settle(before, readDays(d), env.now());
        if (out.finished !== null) {
          await ctx.storage.set("days", out.days);
          await ctx.storage.set("timer", out.state);
          announce(before.phase, out.finished);
        }
        return out;
      }

      /** Tells the phones that a phase ended, once (the end is saved before this runs), and only if it ended just now. */
      function announce(ended: State["phase"], at: number) {
        const how = alertOf(ctx.settings.get());
        if (!how.notify || !ctx.notify || env.now() - at > ANNOUNCE_WITHIN_MS) return;
        const m = endMessage(ended);
        ctx.notify(m.title, { body: m.body, ...(how.sound ? { sound: how.sound } : {}) }).catch((err: unknown) => ctx.log("notify failed:", err instanceof Error ? err.message : err));
      }

      /** The card once a second, only while a phase runs. */
      function follow(state: State) {
        if (state.status !== "running") return stop();
        if (stopTick) return;
        stopTick = env.every(() => {
          void locked(async () => {
            const { state, days } = await load();
            // each tile gets the layout for its own size
            ctx.widgets.push("timer", (tile?: Tile) => ({ render: "card" as const, data: buildCard(state, days, len(), env.now(), tile) }));
            follow(state);
          }).catch((err) => ctx.log("tick failed:", err instanceof Error ? err.message : err));
        }, 1000);
      }

      ctx.widgets.provide("timer", (_settings: unknown, tile?: Tile) => locked(async () => {
        const { state, days } = await load();
        follow(state);
        return { render: "card", data: buildCard(state, days, len(), env.now(), tile) };
      }), { every: 5 });

      const on = (id: string, change: (s: State) => State) => ctx.actions.handle(id, () => locked(async () => {
        const { state, finished } = await load();
        if (finished !== null && env.now() - finished < LATE_TAP_MS) return follow(state);
        const next = change(state);
        await ctx.storage.set("timer", next);
        follow(next);
      }));
      on("toggle", (s) => toggle(s, len(), env.now()));
      on("skip", skip);
      on("reset", reset);
    },
    deactivate: stop,
  };
}

export default createPlugin();
