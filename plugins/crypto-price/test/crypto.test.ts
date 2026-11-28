import { describe, expect, test } from "bun:test";
import { createPlugin } from "../src/index";
import { EVERY_MS, LIMIT_WAIT_MS, coins, currency, listCard, money, parseMarkets, pct, plan, price, priceStat, thin, tickerOf, tone, type Snapshot } from "../src/lib";

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
    // đồng, yen and won have no cents from 1 up; a coin under 1 keeps 4 significant digits in any currency
    expect([money(4123.6, "vnd"), money(15.24, "jpy"), money(15.24, "eur"), money(0.3112, "vnd"), money(0.05678, "usd")]).toEqual(["4,124₫", "¥15", "€15.24", "0.3112₫", "$0.05678"]);
    expect([tone(1.2), tone(-0.3), tone(0), tone(0.001)]).toEqual(["ok", "bad", "muted", "muted"]);
  });
});

const coin = (symbol: string, p: number, pc: number, points = [p * 0.97, p * 1.02, p]) => ({ id: symbol.toLowerCase(), symbol, name: symbol + " coin", price: p, percent: pc, points });
const snap = (n: number, o: Partial<Snapshot> = {}): Snapshot => ({
  at: 0, next: 0, currency: "usd", missing: [],
  coins: ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"].slice(0, n).map((sym, i) => coin(sym, 100 * (i + 1), i % 2 ? -1.5 : 2)), ...o,
});
const parts = (c: { root: any }) => (c.root.children as any[]);

describe("tiles", () => {
  test("plan: rows, hero and footer from the tile's size", () => {
    expect(plan({ w: 4, h: 1 }, 6)).toEqual({ rows: 2, hero: false, footer: false });
    expect(plan({ w: 2, h: 1 }, 6)).toEqual({ rows: 1, hero: false, footer: false });
    expect(plan({ w: 2, h: 2 }, 6)).toEqual({ rows: 4, hero: false, footer: true });
    expect(plan({ w: 4, h: 2 }, 3)).toEqual({ rows: 3, hero: false, footer: true });
    expect(plan({ w: 4, h: 3 }, 6)).toEqual({ rows: 5, hero: true, footer: true });
    expect(plan({ w: 4, h: 4 }, 6)).toEqual({ rows: 6, hero: true, footer: true });
  });
  test("a coin is a ticker row: symbol, name, signed price, change chip and its tone, the week's chart", () => {
    const t = tickerOf(coin("BTC", 59521.4, -3.48, Array.from({ length: 168 }, (_, i) => 59000 + i)), "usd") as any;
    expect(t).toMatchObject({ t: "ticker", symbol: "BTC", name: "BTC coin", price: "$59,521", change: "−3.48%", tone: "bad" });
    expect(t.points.length).toBe(40);
    expect(t.hero).toBeUndefined();
    const hero = tickerOf(coin("BTC", 59521.4, 1, [58100, 61210, 59521]), "usd", { hero: true }) as any;
    expect(hero).toMatchObject({ hero: true, note: "7d high $61,210 · low $58,100", tone: "ok" });
    expect(tickerOf(coin("X", 5, 0, []), "usd")).not.toHaveProperty("points");
  });
  test("the watchlist by size: 4x3 has a hero and four more, 4x1 two rows and no footer, 2x2 four rows with short big prices", () => {
    const big = parts(listCard(snap(6), { w: 4, h: 3 }));
    expect(big.filter((n) => n.t === "ticker").length).toBe(5);
    expect(big[0].hero).toBe(true);
    expect(big.at(-1)).toMatchObject({ t: "text", text: "24h · USD · CoinGecko", tone: "muted" });
    const strip = parts(listCard(snap(6), { w: 4, h: 1 }));
    expect(strip.map((n) => n.t)).toEqual(["ticker", "ticker"]);
    const small = parts(listCard(snap(6, { currency: "vnd", coins: [coin("BTC", 1602345000, 1)] }), { w: 2, h: 2 }));
    expect(small[0].price).toBe("1.6B₫");
    // an error shows even where the footer would not fit
    expect(parts(listCard(snap(2, { error: "CoinGecko answered 500" }), { w: 4, h: 1 })).at(-1)).toMatchObject({ tone: "warn" });
  });
  test("the Price stat: sign, name, change, the week", () => {
    expect(priceStat(coin("BTC", 59526.2, -3.4821), "usd")).toMatchObject({ value: "$59,526", label: "BTC coin", delta: -3.48 });
    expect(priceStat(coin("BTC", 1602345000, 1), "vnd").value).toBe("1.6B₫");
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
  return {
    store, clock, calls, widgets, start,
    show: async (tile = { w: 2, h: 2 }) => JSON.stringify(await widgets.watchlist!(settings, tile)),
    price: async (coin: string) => widgets.price!({ ...settings, coin }, { w: 2, h: 1 }),
  };
}

const markets = (url: URL) => ({ body: url.searchParams.get("ids")!.split(",").map((id) => MARKET[id]).filter(Boolean) });

describe("the plugin", () => {
  test("without coins the tile says what to add, and nothing is asked", async () => {
    const h = harness({ coins: "" }, markets);
    expect(await h.show()).toContain("No coins yet");
    expect(h.calls).toEqual([]);
  });
  test("one request for every coin; again only after a minute; a restart reuses the saved snapshot", async () => {
    const h = harness({ coins: "BTC, ETH, SOL", currency: "usd" }, markets);
    const list = await h.show();
    expect(list).toContain("$61,327");
    expect(list).toContain("−1.12%");
    expect(list).toContain("24h · USD · CoinGecko");
    expect(list).toContain('"t":"ticker"');
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.pathname).toBe("/api/v3/coins/markets");
    expect(h.calls[0]!.searchParams.get("ids")).toBe("bitcoin,ethereum,solana");
    expect(h.calls[0]!.searchParams.get("sparkline")).toBe("true");
    expect(await h.show({ w: 4, h: 3 })).toContain('"hero":true');
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
  test("the Price tile uses the Watchlist's fresh prices, else asks for its own coin", async () => {
    const h = harness({ coins: "BTC, ETH", currency: "usd" }, markets);
    await h.show();
    expect(await h.price("eth")).toEqual({ render: "stat", data: { value: "$2,418", label: "Ethereum", delta: -1.12, points: MARKET.ethereum!.sparkline_in_7d.price } });
    expect(h.calls.length).toBe(1);
    expect((await h.price("solana")).data).toMatchObject({ value: "$142.35", label: "Solana", delta: 2.41 });
    expect(h.calls.length).toBe(2);
    expect(h.calls[1]!.searchParams.get("ids")).toBe("solana");
    await expect(h.price("notacoin")).rejects.toThrow("not found");
  });
});
