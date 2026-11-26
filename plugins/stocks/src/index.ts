import type { PluginContext, PluginModule, Settings } from "@nookdeck/plugin";
import { API, KEY_HELP, apiError, bySymbol, listCard, message, nextAt, quoteCard, quoteOf, symbols, type Quote, type Snapshot, type Tile } from "./lib";

const CACHE = "snapshot";

export interface Env { now: () => number }
const real: Env = { now: Date.now };

/**
 * Tiles ask whenever the agent polls them (every minute); Twelve Data is asked only when the saved snapshot is due (nextAt), by
 * one request at a time, and the snapshot is saved, so a restart does not spend the day's credits again.
 */
export function createPlugin(env: Env = real): PluginModule {
  return {
    activate(ctx: PluginContext) {
      let snap: Snapshot | null = null;
      let failed: Array<{ symbol: string; error: string }> = [];
      let flight: Promise<Snapshot | null> | null = null;
      /** the symbols and key the snapshot was made for: new settings ask again at once */
      let made = "";

      const get = async (url: string): Promise<{ body: any; status: number }> => {
        const r = await ctx.net.fetch(url);
        let body: any = null;
        try { body = await r.json(); } catch { /* not JSON */ }
        return { body, status: r.status };
      };

      async function refresh(): Promise<Snapshot | null> {
        const s = ctx.settings.get();
        const key = typeof s.apikey === "string" ? s.apikey.trim() : "";
        const { list } = symbols(s.symbols);
        const id = JSON.stringify([list, key.length]);
        if (!snap) {
          const saved = (await ctx.storage.get(CACHE)) as (Snapshot & { id?: string }) | null;
          if (saved && Array.isArray(saved.quotes)) { snap = saved; made = saved.id ?? ""; }
        }
        if (!key || !list.length) return snap;
        const now = env.now();
        if (snap && made === id && now < snap.next) return snap;
        const q = encodeURIComponent(list.join(","));
        const k = encodeURIComponent(key);
        try {
          const [quote, series] = await Promise.all([
            get(`${API}/quote?symbol=${q}&apikey=${k}`),
            get(`${API}/time_series?symbol=${q}&interval=5min&outputsize=78&apikey=${k}`),
          ]);
          const whole = apiError(quote.body, quote.status);
          if (whole) {
            // the key or the limit: keep what we had, say why, try again later
            snap = { at: snap?.at ?? now, quotes: made === id ? snap?.quotes ?? [] : [], open: snap?.open ?? false, error: whole, next: nextAt(now, false, true) };
          } else {
            const qs = bySymbol(quote.body, list), ts = bySymbol(series.body, list);
            const quotes: Quote[] = [];
            failed = [];
            for (const sym of list) {
              const one = quoteOf(sym, qs[sym], apiError(series.body, series.status) ? null : ts[sym]);
              if ("error" in one) failed.push(one); else quotes.push(one);
            }
            const open = quotes.some((x) => x.open);
            snap = { at: now, quotes, open, next: nextAt(now, open) };
          }
        } catch (e) {
          snap = { at: snap?.at ?? now, quotes: made === id ? snap?.quotes ?? [] : [], open: false, error: "Could not reach Twelve Data", next: nextAt(now, false, true) };
          ctx.log("fetch failed:", e instanceof Error ? e.message : e);
        }
        made = id;
        await ctx.storage.set(CACHE, { ...snap, id });
        return snap;
      }
      const latest = () => (flight ??= refresh().finally(() => { flight = null; }));

      const empty = (): ReturnType<typeof message> | null => {
        const s = ctx.settings.get();
        if (!(typeof s.apikey === "string" && s.apikey.trim())) return message([KEY_HELP], "settings");
        if (!symbols(s.symbols).list.length) return message(["Add up to 4 symbols in this plugin's settings, such as AAPL, MSFT"], "settings");
        return null;
      };

      ctx.widgets.provide("watchlist", async (_s: Settings, tile?: Tile) => {
        const none = empty();
        if (none) return { render: "card", data: none };
        const s = await latest();
        if (!s || (!s.quotes.length && s.error)) return { render: "card", data: message([s?.error ?? "Loading…"]) };
        return { render: "card", data: listCard(s, tile, failed) };
      }, { every: 60 });

      ctx.widgets.provide("quote", async (ts: Settings, tile?: Tile) => {
        const none = empty();
        if (none) return { render: "card", data: none };
        const want = String(ts.symbol ?? "").trim().toUpperCase();
        const list = symbols(ctx.settings.get().symbols).list;
        const sym = want || list[0]!;
        if (!list.includes(sym)) return { render: "card", data: message([`${sym} is not in this plugin's Symbols setting`, "Add it there (up to 4)"], "settings") };
        const s = await latest();
        const q = s?.quotes.find((x) => x.symbol === sym);
        if (!s || !q) return { render: "card", data: message([failed.find((f) => f.symbol === sym)?.error ?? s?.error ?? "Loading…"]) };
        return { render: "card", data: quoteCard(s, q, tile) };
      }, { every: 60 });
    },
  };
}

export default createPlugin();
