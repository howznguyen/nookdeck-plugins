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
export const KEY_HELP = "Add your free Twelve Data API key in this plugin's settings (twelvedata.com, free plan)";

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
export const pct = (n: number): string => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;
const tone = (n: number) => (n > 0 ? "ok" : n < 0 ? "bad" : "muted");

export function message(lines: string[], icon = "alert-triangle"): CardData {
  return card({ t: "col", gap: 1, align: "center", grow: true, children: [{ t: "icon", name: icon, tone: "muted" }, ...lines.map((l, i) => text(l, { size: "s", tone: i ? "muted" : "default" }))] });
}

const footer = (s: Snapshot): CardNode => text(`${s.open ? "Market open" : "Market closed"}${s.error ? ` · ${s.error}` : ""}`, { size: "s", tone: s.error ? "warn" : "muted" });

/** Every symbol on a row: name, price, change; a sparkline on tiles 4 wide. */
export function listCard(s: Snapshot, tile: Tile = { w: 2, h: 2 }, failed: Array<{ symbol: string; error: string }> = []): CardData {
  const wide = tile.w >= 4;
  const rows: CardNode[] = s.quotes.map((q) => ({ t: "row", gap: 1, align: "between", children: [
    text(q.symbol, { bold: true }),
    wide && q.points.length > 1 && ({ t: "sparkline", points: q.points.slice(-60), tone: tone(q.change) } as CardNode),
    text(price(q.price)),
    { t: "pill", text: pct(q.percent), tone: tone(q.change) },
  ].filter(Boolean) }) as CardNode);
  for (const f of failed) rows.push({ t: "row", gap: 1, align: "between", children: [text(f.symbol, { bold: true }), text(f.error, { size: "s", tone: "muted" })] } as CardNode);
  return card({ t: "col", gap: 1, grow: true, children: [...rows, footer(s)] });
}

/** One symbol, large: price, change, the day's sparkline. */
export function quoteCard(s: Snapshot, q: Quote, tile: Tile = { w: 2, h: 2 }): CardData {
  const small = tile.h <= 1;
  return card({ t: "col", gap: 1, grow: true, children: [
    { t: "row", gap: 1, align: "between", children: [text(q.symbol, { bold: true }), { t: "pill", text: pct(q.percent), tone: tone(q.change) }] },
    { t: "number", value: price(q.price), unit: q.currency, size: small ? "m" : "xl" },
    !small && text(`${q.change > 0 ? "+" : q.change < 0 ? "−" : ""}${price(Math.abs(q.change))} today`, { size: "s", tone: tone(q.change) }),
    !small && q.points.length > 1 && { t: "sparkline", points: q.points.slice(-60), tone: tone(q.change) },
    !small && footer(s),
  ].filter(Boolean) });
}
