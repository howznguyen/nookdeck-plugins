import { describe, expect, test } from "bun:test";
import { createPlugin } from "../src/index";
import { CLOSED_EVERY_MS, KEY_HELP, LIMIT_WAIT_MS, OPEN_EVERY_MS, apiError, pct, price, quoteOf, symbols } from "../src/lib";

// shapes as api.twelvedata.com answered on 2026-11-27 (demo key)
const quote = (symbol: string, close: string, change: string, pc: string, open = true) =>
  ({ symbol, name: symbol + " Inc.", currency: "USD", close, change, percent_change: pc, is_market_open: open });
const series = (closes: number[], day = "2026-11-27") => ({
  meta: { symbol: "X" }, status: "ok",
  // newest first, as Twelve Data sends them; one bar of the day before at the end
  values: [...closes.map((c, i) => ({ datetime: `${day} 15:${String(55 - i * 5).padStart(2, "0")}:00`, close: String(c) })), { datetime: "2026-11-26 15:55:00", close: "1" }],
});

describe("parsing", () => {
  test("symbols: upper case, up to 4, no repeats, bad ones dropped", () => {
    expect(symbols(" aapl, MSFT msft;tsla , btc/usd, nvda, amd")).toEqual({ list: ["AAPL", "MSFT", "TSLA", "BTC/USD"], dropped: ["NVDA", "AMD"] });
    expect(symbols("<script>").list).toEqual([]);
  });
  test("errors: a refused key, the limit, an unknown symbol", () => {
    expect(apiError({ status: "error", code: 401 })).toContain("API key");
    expect(apiError({ status: "error", code: 429 })).toContain("limit");
    expect(apiError({ status: "error", code: 404, message: "symbol not found" })).toBe("symbol not found");
    expect(apiError({ close: "1" })).toBeNull();
  });
  test("a quote and its series: the latest session only, oldest first", () => {
    expect(quoteOf("AAPL", quote("AAPL", "355.58", "1.51", "0.4265"), series([355.4, 355.7, 354.8]))).toMatchObject({ price: 355.58, change: 1.51, percent: 0.4265, open: true, points: [354.8, 355.7, 355.4] });
    expect(quoteOf("X", { status: "error", code: 404, message: "nope" }, null)).toEqual({ symbol: "X", error: "nope" });
  });
  test("numbers", () => {
    expect([price(355.58), price(64250.2), price(0.12345), pct(0.4265), pct(-1.2), pct(0)]).toEqual(["355.58", "64,250", "0.1235", "+0.43%", "−1.20%", "0.00%"]);
  });
});

function harness(settings: Record<string, unknown>, answer: (url: URL) => { status?: number; body: unknown }) {
  const store = new Map<string, unknown>();
  const clock = { now: Date.UTC(2026, 10, 27, 15, 0) };
  const calls: string[] = [];
  const widgets: Record<string, (s: any, tile?: any) => Promise<any>> = {};
  const ctx = {
    id: "dev.nookdeck.stocks", log: () => {},
    settings: { get: () => settings },
    storage: { get: async (k: string) => structuredClone(store.get(k) ?? null), set: async (k: string, v: unknown) => { store.set(k, structuredClone(v)); } },
    net: { fetch: async (u: string) => { const url = new URL(u); calls.push(url.pathname); const a = answer(url); return new Response(JSON.stringify(a.body), { status: a.status ?? 200 }); } },
    widgets: { provide: (id: string, fn: any) => { widgets[id] = fn; }, push: () => {} },
    actions: { handle: () => {} },
  };
  const start = () => createPlugin({ now: () => clock.now }).activate(ctx as any);
  start();
  return { store, clock, calls, widgets, start, show: async (id: string, s: any = {}, tile = { w: 2, h: 2 }) => JSON.stringify(await widgets[id]!(s, tile)) };
}

const market = (url: URL) => {
  const syms = url.searchParams.get("symbol")!.split(",");
  const one = (s: string) => (url.pathname === "/quote" ? quote(s, s === "MSFT" ? "512.10" : "355.58", s === "MSFT" ? "-4.2" : "1.5", s === "MSFT" ? "-0.82" : "0.43") : series([355.4, 355.7, 354.8]));
  return { body: syms.length === 1 ? one(syms[0]!) : Object.fromEntries(syms.map((s) => [s, one(s)])) };
};

describe("the plugin", () => {
  test("without a key the tile says how to get one, and nothing is asked", async () => {
    const h = harness({ symbols: "AAPL" }, market);
    expect(await h.show("watchlist")).toContain(KEY_HELP);
    expect(h.calls).toEqual([]);
  });
  test("two requests for all symbols; again only after 5 minutes while open; a restart reuses the saved snapshot", async () => {
    const h = harness({ apikey: "k", symbols: "AAPL, MSFT" }, market);
    const list = await h.show("watchlist");
    expect(list).toContain("355.58");
    expect(list).toContain("−0.82%");
    expect(list).toContain("Market open");
    expect(h.calls.sort()).toEqual(["/quote", "/time_series"]);
    expect(await h.show("quote", { symbol: "msft" })).toContain("512.10");
    h.clock.now += OPEN_EVERY_MS - 1000;
    await h.show("watchlist");
    expect(h.calls.length).toBe(2);
    h.start(); // the plugin restarts: still no new request
    await h.show("watchlist");
    expect(h.calls.length).toBe(2);
    h.clock.now += 2000;
    await h.show("watchlist");
    expect(h.calls.length).toBe(4);
  });
  test("closed market: every 2 hours; a refused key or the limit: keep the old prices, say why, wait 15 minutes", async () => {
    let mode: "closed" | "limit" = "closed";
    const h = harness({ apikey: "k", symbols: "AAPL" }, (url) => mode === "limit" ? { status: 429, body: { status: "error", code: 429, message: "x" } } : { body: url.pathname === "/quote" ? quote("AAPL", "355.58", "1.5", "0.43", false) : series([1, 2]) });
    expect(await h.show("watchlist")).toContain("Market closed");
    h.clock.now += CLOSED_EVERY_MS - 1000;
    await h.show("watchlist");
    expect(h.calls.length).toBe(2);
    h.clock.now += 2000;
    mode = "limit";
    const shown = await h.show("watchlist");
    expect(shown).toContain("355.58");
    expect(shown).toContain("free limit");
    h.clock.now += LIMIT_WAIT_MS - 1000;
    await h.show("watchlist");
    expect(h.calls.length).toBe(4);
  });
  test("one unknown symbol shows its own error; a symbol tile outside the list says to add it", async () => {
    const h = harness({ apikey: "k", symbols: "AAPL, ZZZZ" }, (url) => {
      const one = (s: string) => (s === "ZZZZ" ? { status: "error", code: 404, message: "**symbol** not found: ZZZZ" } : url.pathname === "/quote" ? quote(s, "355.58", "1", "0.3") : series([1, 2]));
      return { body: { AAPL: one("AAPL"), ZZZZ: one("ZZZZ") } };
    });
    const list = await h.show("watchlist");
    expect(list).toContain("355.58");
    expect(list).toContain("not found: ZZZZ");
    expect(await h.show("quote", { symbol: "TSLA" })).toContain("not in this plugin");
  });
});
