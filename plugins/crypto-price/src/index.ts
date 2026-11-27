import type { PluginContext, PluginModule, Settings } from "@nookdeck/plugin";
import { API, EVERY_MS, LIMIT_WAIT_MS, apiError, coins, currency, listCard, message, parseMarkets, type Snapshot, type Tile } from "./lib";

const CACHE = "snapshot";

export interface Env { now: () => number }
const real: Env = { now: Date.now };

/**
 * The Watchlist tile asks whenever the agent polls it (every minute); CoinGecko is asked only when the saved snapshot is due, by
 * one request at a time, and the snapshot is saved, so a restart does not ask again at once. The "Price" tile (one coin) is the
 * manifest's own http source and does not go through this code.
 */
export function createPlugin(env: Env = real): PluginModule {
  return {
    activate(ctx: PluginContext) {
      let snap: Snapshot | null = null;
      let flight: Promise<Snapshot | null> | null = null;
      /** the coins and currency the snapshot was made for: new settings ask again at once */
      let made = "";

      async function refresh(): Promise<Snapshot | null> {
        const s = ctx.settings.get();
        const { list } = coins(s.coins);
        const cur = currency(s.currency);
        const id = JSON.stringify([list, cur]);
        if (!snap) {
          const saved = (await ctx.storage.get(CACHE)) as (Snapshot & { id?: string }) | null;
          if (saved && Array.isArray(saved.coins)) { snap = saved; made = saved.id ?? ""; }
        }
        if (!list.length) return snap;
        const now = env.now();
        if (snap && made === id && now < snap.next) return snap;
        const keep = made === id ? snap : null; // other coins or currency: the old prices do not fit
        try {
          const r = await ctx.net.fetch(`${API}/coins/markets?vs_currency=${cur}&ids=${encodeURIComponent(list.join(","))}&sparkline=true&price_change_percentage=24h`);
          const err = apiError(r.status);
          if (err) {
            snap = { at: keep?.at ?? now, coins: keep?.coins ?? [], currency: cur, missing: keep?.missing ?? [], error: err, next: now + LIMIT_WAIT_MS };
          } else {
            const { coins: got, missing } = parseMarkets(await r.json(), list);
            snap = { at: now, coins: got, currency: cur, missing, next: now + EVERY_MS };
          }
        } catch (e) {
          snap = { at: keep?.at ?? now, coins: keep?.coins ?? [], currency: cur, missing: keep?.missing ?? [], error: "Could not reach CoinGecko", next: now + LIMIT_WAIT_MS };
          ctx.log("fetch failed:", e instanceof Error ? e.message : e);
        }
        made = id;
        await ctx.storage.set(CACHE, { ...snap, id });
        return snap;
      }
      const latest = () => (flight ??= refresh().finally(() => { flight = null; }));

      ctx.widgets.provide("watchlist", async (_s: Settings, tile?: Tile) => {
        if (!coins(ctx.settings.get().coins).list.length) return { render: "card", data: message(["Add up to 6 coins in this plugin's settings, such as BTC, ETH, SOL"], "settings") };
        const s = await latest();
        if (!s || (!s.coins.length && !s.missing.length)) return { render: "card", data: message([s?.error ?? "Loading…"]) };
        return { render: "card", data: listCard(s, tile) };
      }, { every: 60 });
    },
  };
}

export default createPlugin();
