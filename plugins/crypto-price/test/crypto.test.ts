import { describe, expect, test } from "bun:test";
import { createPlugin } from "../src/index";
import { EVERY_MS, LIMIT_WAIT_MS, coins, currency, money, parseMarkets, pct, price, thin } from "../src/lib";

// the shape api.coingecko.com/api/v3/coins/markets answered on 2026-11-27
const row = (id: string, symbol: string, p: number, pc: number) => ({
  id, symbol, name: id[0]!.toUpperCase() + id.slice(1), current_price: p, price_change_percentage_24h: pc,
  sparkline_in_7d: { price: [p * 0.98, p * 0.99, p] }, last_updated: "2026-11-27T04:05:53.000Z",
});
const MARKET: Record<string, ReturnType<typeof row>> = {
  bitcoin: row("bitcoin", "btc", 61327, 0.80085), ethereum: row("ethereum", "eth", 2418.4, -1.12), solana: row("solana", "sol", 142.35, 2.41),
  "shiba-inu": row("shiba-inu", "shib", 0.0000123456, -3),
};

describe("parsing", () => {
  test("coins: tickers to ids, up to 6, no repeats, bad ones dropped", () => {
    expect(coins(" BTC, ethereum eth;sol , pepe, doge, ada, xrp")).toEqual({ list: ["bitcoin", "ethereum", "solana", "pepe", "dogecoin", "cardano"], dropped: ["xrp"] });
    expect(coins("<script>").list).toEqual([]);
    expect(coins("").list).toEqual([]);
  });
  test("currency: a listed one, else usd", () => {
    expect([currency("VND"), currency("xyz"), currency(undefined)]).toEqual(["vnd", "usd", "usd"]);
  });
  test("markets: in the list's order, unknown ids reported", () => {
    const r = parseMarkets([MARKET.solana, MARKET.bitcoin], ["bitcoin", "nope", "solana"]);
    expect(r.coins.map((c) => c.symbol)).toEqual(["BTC", "SOL"]);
    expect(r.coins[0]).toMatchObject({ price: 61327, percent: 0.80085, points: [61327 * 0.98, 61327 * 0.99, 61327] });
    expect(r.missing).toEqual(["nope"]);
    expect(parseMarkets({ error: "x" }, ["bitcoin"]).missing).toEqual(["bitcoin"]);
  });
  test("the week's prices fit a sparkline: at most 56, first and latest kept", () => {
    const week = Array.from({ length: 168 }, (_, i) => i);
    const t = thin(week);
    expect(t.length).toBe(56);
    expect(t.at(-1)).toBe(167);
    expect(t[0]).toBeLessThan(5);
    expect(thin([1, 2, 3])).toEqual([1, 2, 3]);
  });
  test("numbers", () => {
    expect([price(61327.4), price(142.354), price(0.4521), price(0.0000123456), price(1602345000, true), pct(0.80085), pct(-1.2)])
      .toEqual(["61,327", "142.35", "0.4521", "0.00001235", "1.6B", "+0.80%", "−1.20%"]);
    expect([money(61327, "usd"), money(1602345000, "vnd"), money(1602345000, "vnd", true), money(10, "chf")]).toEqual(["$61,327", "1,602,345,000₫", "1.6B₫", "10.00 CHF"]);
  });
});

function harness(settings: Record<string, unknown>, answer: (url: URL) => { status?: number; body: unknown }) {
  const store = new Map<string, unknown>();
  const clock = { now: Date.UTC(2026, 10, 27, 4, 0) };
  const calls: URL[] = [];
  const widgets: Record<string, (s: any, tile?: any) => Promise<any>> = {};
  const ctx = {
    id: "dev.nookdeck.crypto-price", log: () => {},
    settings: { get: () => settings },
    storage: { get: async (k: string) => structuredClone(store.get(k) ?? null), set: async (k: string, v: unknown) => { store.set(k, structuredClone(v)); } },
    net: { fetch: async (u: string) => { const url = new URL(u); calls.push(url); const a = answer(url); return new Response(JSON.stringify(a.body), { status: a.status ?? 200 }); } },
    widgets: { provide: (id: string, fn: any) => { widgets[id] = fn; }, push: () => {} },
    actions: { handle: () => {} },
  };
  const start = () => createPlugin({ now: () => clock.now }).activate(ctx as any);
  start();
  return { store, clock, calls, widgets, start, show: async (tile = { w: 2, h: 2 }) => JSON.stringify(await widgets.watchlist!({}, tile)) };
}

const markets = (url: URL) => ({ body: url.searchParams.get("ids")!.split(",").map((id) => MARKET[id]).filter(Boolean) });

describe("the plugin", () => {
  test("without coins the tile says what to add, and nothing is asked", async () => {
    const h = harness({ coins: "" }, markets);
    expect(await h.show()).toContain("Add up to 6 coins");
    expect(h.calls).toEqual([]);
  });
  test("one request for every coin; again only after a minute; a restart reuses the saved snapshot", async () => {
    const h = harness({ coins: "BTC, ETH, SOL", currency: "usd" }, markets);
    const list = await h.show();
    expect(list).toContain("$61,327");
    expect(list).toContain("−1.12%");
    expect(list).toContain("24h · USD · CoinGecko");
    expect(list).not.toContain("sparkline"); // 2 wide: no chart
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.pathname).toBe("/api/v3/coins/markets");
    expect(h.calls[0]!.searchParams.get("ids")).toBe("bitcoin,ethereum,solana");
    expect(h.calls[0]!.searchParams.get("sparkline")).toBe("true");
    expect(await h.show({ w: 4, h: 2 })).toContain("sparkline");
    h.clock.now += EVERY_MS - 1000;
    await h.show();
    expect(h.calls.length).toBe(1);
    h.start(); // the plugin restarts: still no new request
    await h.show();
    expect(h.calls.length).toBe(1);
    h.clock.now += 2000;
    await h.show();
    expect(h.calls.length).toBe(2);
  });
  test("too many requests: keep the old prices, say why, wait a few minutes", async () => {
    let limited = false;
    const h = harness({ coins: "BTC" }, (url) => (limited ? { status: 429, body: { status: { error_code: 429 } } } : markets(url)));
    await h.show();
    h.clock.now += EVERY_MS;
    limited = true;
    const shown = await h.show();
    expect(shown).toContain("$61,327");
    expect(shown).toContain("free limit");
    h.clock.now += LIMIT_WAIT_MS - 1000;
    await h.show();
    expect(h.calls.length).toBe(2);
  });
  test("new coins or currency ask again at once; an unknown coin shows its own row", async () => {
    const settings: Record<string, unknown> = { coins: "BTC", currency: "usd" };
    const h = harness(settings, markets);
    await h.show();
    settings.coins = "BTC, notacoin";
    settings.currency = "vnd";
    const shown = await h.show();
    expect(h.calls.length).toBe(2);
    expect(h.calls[1]!.searchParams.get("vs_currency")).toBe("vnd");
    expect(shown).toContain("notacoin");
    expect(shown).toContain("not found on CoinGecko");
    expect(shown).toContain("24h · VND");
  });
});
