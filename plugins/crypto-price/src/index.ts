import type { PluginContext, PluginModule, Settings } from "@nookdeck/plugin";
import { API, EVERY_MS, LIMIT_WAIT_MS, NO_COINS, apiError, coins, currency, listCard, message, parseMarkets, priceStat, type Snapshot, type Tile } from "./lib";

/** The Watchlist's saved snapshot; a Price tile's coin is saved as "price:<id>:<currency>". */
const CACHE = "snapshot";

export interface Env { now: () => number }
const real: Env = { now: Date.now };

/**
 * Tiles ask whenever the agent polls them (every minute); CoinGecko is asked only when a saved snapshot is due, by one request at
 * a time for each list of coins, and the snapshot is saved, so a restart does not ask again at once. The Watchlist asks for all
 * its coins at once; a Price tile whose coin is in that fresh snapshot uses it, else it asks for its own coin.
 */
export function createPlugin(env: Env = real): PluginModule {
  return {
    activate(ctx: PluginContext) {
      const snaps = new Map<string, Snapshot & { id: string }>();
      const flights = new Map<string, Promise<Snapshot | null>>();

      async function refresh(key: string, list: string[], cur: string): Promise<Snapshot | null> {
        const id = JSON.stringify([list, cur]);
        let snap = snaps.get(key) ?? null;
        if (!snap) {
          const saved = (await ctx.storage.get(key)) as (Snapshot & { id?: string }) | null;
          if (saved && Array.isArray(saved.coins)) { snap = { ...saved, id: saved.id ?? "" }; snaps.set(key, snap); }
        }
        if (!list.length) return snap;
        const now = env.now();
        if (snap && snap.id === id && now < snap.next) return snap;
        const keep = snap && snap.id === id ? snap : null; // other coins or currency: the old prices do not fit
        let next: Snapshot;
        try {
          const r = await ctx.net.fetch(`${API}/coins/markets?vs_currency=${cur}&ids=${encodeURIComponent(list.join(","))}&sparkline=true&price_change_percentage=24h`);
          const err = apiError(r.status);
          if (err) {
            next = { at: keep?.at ?? now, coins: keep?.coins ?? [], currency: cur, missing: keep?.missing ?? [], error: err, next: now + LIMIT_WAIT_MS };
          } else {
            const { coins: got, missing } = parseMarkets(await r.json(), list);
            next = { at: now, coins: got, currency: cur, missing, next: now + EVERY_MS };
          }
        } catch (e) {
          next = { at: keep?.at ?? now, coins: keep?.coins ?? [], currency: cur, missing: keep?.missing ?? [], error: "Could not reach CoinGecko", next: now + LIMIT_WAIT_MS };
          ctx.log("fetch failed:", e instanceof Error ? e.message : e);
        }
        const saved = { ...next, id };
        snaps.set(key, saved);
        await ctx.storage.set(key, saved);
        return saved;
      }
      const latest = (key: string, list: string[], cur: string): Promise<Snapshot | null> => {
        let f = flights.get(key);
        if (!f) { f = refresh(key, list, cur).finally(() => flights.delete(key)); flights.set(key, f); }
        return f;
      };

      ctx.widgets.provide("watchlist", async (s: Settings, tile?: Tile) => {
        const list = coins(s.coins).list;
        if (!list.length) return { render: "card", data: NO_COINS() };
        const snap = await latest(CACHE, list, currency(s.currency));
        if (!snap || (!snap.coins.length && !snap.missing.length)) return { render: "card", data: snap?.error ? message("No prices yet", snap.error) : message("Loading prices", "", "refresh") };
        return { render: "card", data: listCard(snap, tile) };
      }, { every: 60 });

      ctx.widgets.provide("price", async (s: Settings) => {
        const id = coins(s.coin).list[0] ?? "bitcoin";
        const cur = currency(s.currency);
        // the Watchlist's snapshot, when it is fresh and has this coin in this currency
        const wl = snaps.get(CACHE);
        const now = env.now();
        let c = wl && wl.currency === cur && now < wl.next ? wl.coins.find((x) => x.id === id) : undefined;
        let err: string | undefined;
        if (!c) {
          const snap = await latest(`price:${id}:${cur}`, [id], cur);
          c = snap?.coins[0];
          err = snap?.error ?? (snap?.missing.length ? `${id}: not found on CoinGecko` : undefined);
        }
        if (!c) throw new Error(err ?? "No price yet");
        return { render: "stat", data: priceStat(c, cur) };
      }, { every: 60 });
    },
  };
}

export default createPlugin();
