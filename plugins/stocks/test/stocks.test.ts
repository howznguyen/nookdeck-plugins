import { describe, expect, test } from "bun:test";
import { createPlugin } from "../src/index";
import { CLOSED_EVERY_MS, KEY_HELP, LIMIT_WAIT_MS, OPEN_EVERY_MS, apiError, listCard, money, pct, plan, price, quoteCard, quoteOf, symbols, thin, type Quote, type Snapshot } from "../src/lib";

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
    expect([money(355.58, "USD"), money(92.1, "EUR"), money(1250, "VND"), money(412.5, "GBp"), money(10, "SEK")]).toEqual(["$355.58", "€92.10", "1,250₫", "412.50p", "10.00"]);
  });
  test("the day's 78 closes fit a chart: at most 56, the latest kept", () => {
    const day = Array.from({ length: 78 }, (_, i) => i);
    expect(thin(day).length).toBe(56);
    expect(thin(day).at(-1)).toBe(77);
  });
});

const q = (symbol: string, change: number, points = [1, 2, 3]): Quote => ({ symbol, name: symbol + " Inc", currency: "USD", price: 355.58, change, percent: change / 3.5, open: true, points });
const snap = (o: Partial<Snapshot> = {}): Snapshot => ({ at: 0, next: 0, open: true, quotes: [q("AAPL", 1.51), q("MSFT", -4.2), q("TSLA", 0)], ...o });
const parts = (c: { root: any }) => (c.root.children as any[]);

describe("tiles", () => {
  test("plan: rows, hero and footer from the tile's size", () => {
    expect(plan({ w: 4, h: 1 }, 4)).toEqual({ rows: 2, hero: false, footer: false });
    expect(plan({ w: 2, h: 2 }, 4)).toEqual({ rows: 4, hero: false, footer: true });
    expect(plan({ w: 4, h: 3 }, 4)).toEqual({ rows: 4, hero: true, footer: true });
  });
  test("watchlist rows are tickers with the currency sign, the change chip and its tone; the footer says the market's state", () => {
    const rows = parts(listCard(snap({ open: false }), { w: 4, h: 2 }));
    expect(rows[0]).toMatchObject({ t: "ticker", symbol: "AAPL", name: "AAPL Inc", price: "$355.58", change: "+0.43%", tone: "ok", points: [1, 2, 3] });
    expect(rows[1].tone).toBe("bad");
    expect(rows[2].tone).toBe("muted");
    expect(rows.at(-1)).toMatchObject({ t: "text", text: "Market closed · Twelve Data", tone: "muted" });
    expect(parts(listCard(snap(), { w: 4, h: 3 }))[0]).toMatchObject({ hero: true, note: "+1.51 today · Market open" });
  });
  test("one symbol: a hero row, or one row on a 1-high tile; a closed market says the change was at the close", () => {
    expect(parts(quoteCard(snap({ open: false }), q("MSFT", -4.2), { w: 3, h: 2 }))[0]).toMatchObject({ t: "ticker", hero: true, note: "−4.20 at the close · Market closed", tone: "bad" });
    expect(parts(quoteCard(snap(), q("MSFT", -4.2), { w: 2, h: 1 }))[0].hero).toBeUndefined();
  });
  test("the empty tile's lines are short enough for a 2x2 tile", () => {
    for (const l of KEY_HELP) expect(l.length).toBeLessThanOrEqual(22);
    expect(KEY_HELP.join(" ")).toContain("Plugins › Stocks");
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
    expect(await h.show("watchlist")).toContain("Add an API key");
    expect(await h.show("quote")).toContain("twelvedata.com");
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
    expect(await h.show("quote", { symbol: "TSLA" })).toContain("TSLA is not in the list");
  });
});
