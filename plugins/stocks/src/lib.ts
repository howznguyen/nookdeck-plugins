/**
 * Quotes from Twelve Data (api.twelvedata.com) with the owner's own free API key. The free plan limits the credits a day and a
 * minute (one credit per symbol per request), so the plugin asks only every 5 minutes while a market is open and every 2 hours
 * while all are closed, for at most 4 symbols: 2 requests of 4 credits each time.
 */
import type { CardData, CardNode } from "@nookdeck/plugin";

export const MAX_SYMBOLS = 4;
export const OPEN_EVERY_MS = 5 * 60_000;
export const CLOSED_EVERY_MS = 2 * 60 * 60_000;
/** After "limit reached", wait this long before asking again. */
export const LIMIT_WAIT_MS = 15 * 60_000;
export const API = "https://api.twelvedata.com";
/** The empty tile without a key: three short lines, each fits a 2x2 tile (the deck leaves the last ones out on smaller tiles). */
export const KEY_HELP = ["Add an API key", "free at twelvedata.com", "in Plugins › Stocks"] as const;

export interface Quote {
  symbol: string;
  name: string;
  currency: string;
  price: number;
  change: number;
  percent: number;
  open: boolean;
  /** today's (or the last session's) closes, oldest first */
  points: number[];
}
export interface Snapshot { at: number; quotes: Quote[]; open: boolean; error?: string; /** no new request before this */ next: number }

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-:^/]{0,19}$/;

/** "aapl, MSFT msft;TSLA" -> ["AAPL", "MSFT", "TSLA"]: up to 4, in order, without repeats or bad ones. */
export function symbols(v: unknown): { list: string[]; dropped: string[] } {
  const all = String(v ?? "").toUpperCase().split(/[\s,;]+/).filter(Boolean);
  const list: string[] = [], dropped: string[] = [];
  for (const s of all) {
    if (list.includes(s)) continue;
    if (!SYMBOL_RE.test(s) || list.length >= MAX_SYMBOLS) dropped.push(s); else list.push(s);
  }
  return { list, dropped };
}

const num = (v: unknown): number => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "")); return Number.isFinite(n) ? n : NaN; };

/** Twelve Data answers a batch keyed by symbol, and one symbol on its own: always give back symbol -> object. */
export function bySymbol(body: any, list: string[]): Record<string, any> {
  if (list.length === 1) return { [list[0]!]: body };
  return body && typeof body === "object" ? body : {};
}

/** A Twelve Data error body ({status:"error", code, message}) as a short message for the tile; null when it is not one. */
export function apiError(body: any, httpStatus = 200): string | null {
  const code = Number(body?.code ?? httpStatus);
  if (body?.status !== "error" && httpStatus < 400) return null;
  if (code === 401 || code === 403) return "Twelve Data refused the API key: check it in the plugin settings";
  if (code === 429) return "Twelve Data's free limit is reached for now: trying again later";
  if (code === 404 || code === 400) return String(body?.message ?? "Unknown symbol").slice(0, 120);
  return `Twelve Data answered ${code}`;
}

/** One symbol's quote and 5-minute series, or an error text for that symbol. */
export function quoteOf(symbol: string, q: any, ts: any): Quote | { symbol: string; error: string } {
  const bad = apiError(q) ?? (ts ? apiError(ts) : null);
  if (bad) return { symbol, error: bad };
  const price = num(q?.close), change = num(q?.change), percent = num(q?.percent_change);
  if (!Number.isFinite(price)) return { symbol, error: "No price" };
  const values: any[] = Array.isArray(ts?.values) ? ts.values : [];
  // the latest session only: the date of the newest bar
  const day = String(values[0]?.datetime ?? "").slice(0, 10);
  const points = values.filter((v) => String(v?.datetime ?? "").startsWith(day)).map((v) => num(v.close)).filter(Number.isFinite).reverse().slice(-78);
  return {
    symbol, name: String(q?.name ?? symbol).slice(0, 60), currency: String(q?.currency ?? ""),
    price, change: Number.isFinite(change) ? change : 0, percent: Number.isFinite(percent) ? percent : 0, open: q?.is_market_open === true, points,
  };
}

/** When to ask Twelve Data again. */
export function nextAt(now: number, open: boolean, limited = false): number {
  return now + (limited ? LIMIT_WAIT_MS : open ? OPEN_EVERY_MS : CLOSED_EVERY_MS);
}

// ---------------------------------------------------------------- tiles

export interface Tile { w: number; h: number }
const text = (t: string, o: Record<string, unknown> = {}): CardNode => ({ t: "text", text: t.slice(0, 200), ...o }) as CardNode;
const card = (root: unknown): CardData => ({ root }) as CardData;

export function price(n: number): string {
  const digits = Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 1 ? 2 : 4;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
const SIGN: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", HKD: "HK$", INR: "₹", KRW: "₩", CAD: "C$", AUD: "A$", CHF: "CHF ", VND: "₫" };
/** The price with its currency's sign ("$355.58", "€92.10", "1,250₫"); an unknown currency shows the bare number. */
export function money(n: number, currency: string): string {
  const cur = currency.toUpperCase();
  if (cur === "GBX" || currency === "GBp") return `${price(n)}p`; // London prices in pence
  const s = SIGN[cur];
  if (!s) return price(n);
  return cur === "VND" ? `${price(n)}₫` : `${s}${price(n)}`;
}
export const pct = (n: number): string => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;
const signed = (n: number): string => `${n > 0 ? "+" : n < 0 ? "−" : ""}${price(Math.abs(n))}`;
export const tone = (n: number) => (n > 0 ? "ok" : n < 0 ? "bad" : "muted");

/** A card chart takes up to 60 points: the day's 5-minute closes (up to 78), every nth one, always ending on the latest. */
export function thin(points: number[], max = 56): number[] {
  if (points.length <= max) return points;
  const step = points.length / max;
  return Array.from({ length: max }, (_, i) => points[Math.round(points.length - 1 - (max - 1 - i) * step)]!);
}

/** An empty or waiting tile: an icon and up to three short lines, the first in the text colour; the deck drops the last lines on small tiles. */
export function message(lines: readonly string[], icon = "alert-triangle"): CardData {
  return card({ t: "col", gap: 1, align: "center", grow: true, children: [{ t: "icon", name: icon, tone: "muted" }, ...lines.slice(0, 3).map((l, i) => text(l, { size: i ? "s" : "m", tone: i ? "muted" : "default" }))] });
}

const state = (s: Snapshot) => (s.open ? "Market open" : "Market closed");
const footer = (s: Snapshot): CardNode => text(`${state(s)} · Twelve Data${s.error ? ` · ${s.error}` : ""}`, { size: "s", tone: s.error ? "warn" : "muted" });

/** How a watchlist uses its tile: how many rows, whether the first is a hero row, and whether the footer fits. */
export function plan(tile: Tile, count: number): { rows: number; hero: boolean; footer: boolean } {
  const { w, h } = tile;
  if (h <= 1) return { rows: Math.min(count, w >= 3 ? 2 : 1), hero: false, footer: false };
  if (h === 2) return { rows: Math.min(count, MAX_SYMBOLS), hero: false, footer: true };
  // a hero takes about two rows: on a 3-high tile it and three more (all four), as on taller ones
  return { rows: Math.min(count, MAX_SYMBOLS), hero: w >= 3, footer: true };
}

/** One symbol as a ticker row: symbol, company, price with its sign, the day's change and its chart. A hero says the change in money too. */
export function tickerOf(q: Quote, s: Snapshot, hero = false): CardNode {
  return {
    t: "ticker", symbol: q.symbol.slice(0, 16), name: q.name.slice(0, 60), price: money(q.price, q.currency).slice(0, 40),
    change: pct(q.percent), tone: tone(q.change),
    ...(q.points.length > 1 ? { points: thin(q.points, hero ? 60 : 40) } : {}),
    ...(hero ? { hero: true, note: `${signed(q.change)} ${s.open ? "today" : "at the close"} · ${state(s)}` } : {}),
  } as CardNode;
}

/** Every symbol on a row (the first one large on tall tiles), then the ones that failed, then the market's state. */
export function listCard(s: Snapshot, tile: Tile = { w: 2, h: 2 }, failed: Array<{ symbol: string; error: string }> = []): CardData {
  const p = plan(tile, s.quotes.length + failed.length);
  const rows: CardNode[] = s.quotes.slice(0, p.rows).map((q, i) => tickerOf(q, s, p.hero && i === 0));
  for (const f of failed.slice(0, Math.max(0, p.rows - rows.length))) rows.push({ t: "row", gap: 1, align: "between", children: [text(f.symbol, { bold: true }), text(f.error, { size: "s", tone: "muted" })] } as CardNode);
  return card({ t: "col", gap: 0, grow: true, children: [...rows, (p.footer || s.error) && footer(s)].filter(Boolean) });
}

/** One symbol, large: a hero row (price, change, the day's chart, the change in money and the market's state); one row on a 1-high tile. */
export function quoteCard(s: Snapshot, q: Quote, tile: Tile = { w: 2, h: 2 }): CardData {
  if (tile.h <= 1) return card({ t: "col", gap: 0, grow: true, align: "center", children: [tickerOf(q, s)] });
  return card({ t: "col", gap: 0, grow: true, children: [tickerOf(q, s, true), s.error && footer(s)].filter(Boolean) });
}
