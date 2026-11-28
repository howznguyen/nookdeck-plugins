/**
 * Coin prices from CoinGecko's free public API (api.coingecko.com, no key). One request covers every coin of the list
 * (/coins/markets: price, 24-hour change and the 7-day sparkline), asked once a minute at most; after "too many requests" the
 * plugin waits a few minutes and keeps the last prices on the tile.
 */
import type { CardData, CardNode } from "@nookdeck/plugin";

export const MAX_COINS = 6;
export const EVERY_MS = 60_000;
/** After a 429 or an error, wait this long before asking again. */
export const LIMIT_WAIT_MS = 3 * 60_000;
export const API = "https://api.coingecko.com/api/v3";
export const CURRENCIES = ["usd", "eur", "vnd", "jpy", "gbp", "aud", "cad", "sgd", "krw", "inr", "brl"] as const;

/** Tickers people type, as CoinGecko ids (CoinGecko itself only takes ids such as "bitcoin"). */
export const ALIASES: Record<string, string> = {
  btc: "bitcoin", eth: "ethereum", sol: "solana", bnb: "binancecoin", xrp: "ripple", doge: "dogecoin", ada: "cardano",
  ton: "the-open-network", trx: "tron", usdt: "tether", usdc: "usd-coin", avax: "avalanche-2", dot: "polkadot", link: "chainlink",
  ltc: "litecoin", shib: "shiba-inu", sui: "sui", pepe: "pepe", near: "near", apt: "aptos", arb: "arbitrum", op: "optimism",
  matic: "matic-network", pol: "polygon-ecosystem-token", atom: "cosmos", xlm: "stellar", bch: "bitcoin-cash", uni: "uniswap",
  hype: "hyperliquid", wld: "worldcoin-wld",
};

export interface Coin {
  id: string;
  symbol: string;
  name: string;
  price: number;
  /** 24-hour change in percent */
  percent: number;
  /** the last 7 days, oldest first (hourly) */
  points: number[];
}
export interface Snapshot { at: number; coins: Coin[]; currency: string; missing: string[]; error?: string; /** no new request before this */ next: number }

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** "BTC, ethereum eth;solana" -> ["bitcoin", "ethereum", "solana"]: tickers mapped to ids, up to 6, in order, no repeats. */
export function coins(v: unknown): { list: string[]; dropped: string[] } {
  const all = String(v ?? "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const list: string[] = [], dropped: string[] = [];
  for (const raw of all) {
    const id = ALIASES[raw] ?? raw;
    if (list.includes(id)) continue;
    if (!ID_RE.test(id) || list.length >= MAX_COINS) dropped.push(raw); else list.push(id);
  }
  return { list, dropped };
}

export function currency(v: unknown): string {
  const c = String(v ?? "").trim().toLowerCase();
  return (CURRENCIES as readonly string[]).includes(c) ? c : "usd";
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

/** The /coins/markets answer as coins, in the order of the list, and the ids CoinGecko did not know. */
export function parseMarkets(body: unknown, list: string[]): { coins: Coin[]; missing: string[] } {
  const rows = Array.isArray(body) ? body : [];
  const byId = new Map(rows.filter((r) => r && typeof r.id === "string").map((r) => [r.id as string, r]));
  const out: Coin[] = [], missing: string[] = [];
  for (const id of list) {
    const r = byId.get(id);
    const price = num(r?.current_price);
    if (!r || !Number.isFinite(price)) { missing.push(id); continue; }
    const pts = Array.isArray(r.sparkline_in_7d?.price) ? (r.sparkline_in_7d.price as unknown[]).map(num).filter(Number.isFinite) : [];
    const pc = num(r.price_change_percentage_24h);
    out.push({ id, symbol: String(r.symbol ?? id).toUpperCase().slice(0, 12), name: String(r.name ?? id).slice(0, 60), price, percent: Number.isFinite(pc) ? pc : 0, points: pts });
  }
  return { coins: out, missing };
}

/** A failed answer as a short message for the tile; null when it is not one. */
export function apiError(status: number): string | null {
  if (status < 400) return null;
  if (status === 429) return "CoinGecko's free limit is reached for now: trying again in a few minutes";
  return `CoinGecko answered ${status}`;
}

// ---------------------------------------------------------------- tiles

export interface Tile { w: number; h: number }
const text = (t: string, o: Record<string, unknown> = {}): CardNode => ({ t: "text", text: t.slice(0, 200), ...o }) as CardNode;
const card = (root: unknown): CardData => ({ root }) as CardData;

const SIGN: Record<string, string> = { usd: "$", eur: "€", gbp: "£", jpy: "¥", krw: "₩", inr: "₹", vnd: "₫", brl: "R$", aud: "A$", cad: "C$", sgd: "S$" };
/** Currencies whose prices are shown without cents once they reach 1 (a coin in đồng, yen or won has no useful cents). */
const WHOLE = ["vnd", "jpy", "krw"];

/** 61,327 / 142.35 / 0.4521 / 0.00001234; compact (1.6B) when asked and the number is large. `whole`: no cents from 1 up. */
export function price(n: number, compact = false, whole = false): string {
  const a = Math.abs(n);
  if (compact && a >= 1e6) return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: a >= 1e9 ? 2 : 1 });
  if (a >= 1000 || (whole && a >= 1)) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (a >= 1) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a === 0) return "0";
  return n.toPrecision(4).replace(/0+$/, "");
}
/** The price with its currency sign: "$61,327", "1,602,345,000₫", "¥9,512,300". */
export function money(n: number, cur: string, compact = false): string {
  const s = SIGN[cur];
  const p = price(n, compact, WHOLE.includes(cur));
  if (!s) return `${p} ${cur.toUpperCase()}`;
  return cur === "vnd" ? `${p}₫` : `${s}${p}`;
}
export const pct = (n: number): string => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;
export const tone = (n: number) => (Math.abs(n) < 0.005 ? "muted" : n > 0 ? "ok" : "bad");

/** A card chart takes up to 60 points: the week's ~168 hourly prices, every nth one, always ending on the latest. */
export function thin(points: number[], max = 56): number[] {
  if (points.length <= max) return points;
  const step = points.length / max;
  return Array.from({ length: max }, (_, i) => points[Math.round(points.length - 1 - (max - 1 - i) * step)]!);
}

/**
 * An empty or waiting tile: an icon, one short line, and a hint under it. Each line is short enough for a 2x2 tile; the hint
 * and `more` are left out by the deck first when the tile is small.
 */
export function message(title: string, hint = "", icon = "alert-triangle", more = ""): CardData {
  return card({ t: "col", gap: 1, align: "center", grow: true, children: [
    { t: "icon", name: icon, tone: "muted" },
    text(title),
    hint && text(hint, { size: "s", tone: "muted" }),
    more && text(more, { size: "s", tone: "muted" }),
  ].filter(Boolean) });
}
export const NO_COINS = () => message("No coins yet", "Add them in Plugins", "settings", "such as BTC, ETH, SOL");

const footer = (s: Snapshot): CardNode => text(`24h · ${s.currency.toUpperCase()} · CoinGecko${s.error ? ` · ${s.error}` : ""}`, { size: "s", tone: s.error ? "warn" : "muted" });

/** The week's high and low of a coin, for the hero row. */
export function weekNote(c: Coin, cur: string): string | undefined {
  if (c.points.length < 2) return undefined;
  const hi = Math.max(...c.points), lo = Math.min(...c.points);
  return `7d high ${money(hi, cur, true)} · low ${money(lo, cur, true)}`;
}

/** How a watchlist uses its tile: how many coin rows, whether the first is a hero row, and whether the footer fits. */
export function plan(tile: Tile, count: number): { rows: number; hero: boolean; footer: boolean } {
  const { w, h } = tile;
  if (h <= 1) return { rows: Math.min(count, w >= 3 ? 2 : 1), hero: false, footer: false };
  if (h === 2) return { rows: Math.min(count, 4), hero: false, footer: true };
  // a hero takes about two rows: on a 3-high tile it and four more, all six from 4 high
  if (h === 3 && w >= 3) return { rows: Math.min(count, 5), hero: true, footer: true };
  return { rows: Math.min(count, MAX_COINS), hero: w >= 3, footer: true };
}

/** One coin as a ticker row: symbol, name, price, 24-hour change, the week's chart (the deck drops what does not fit). */
export function tickerOf(c: Coin, cur: string, o: { compact?: boolean; hero?: boolean } = {}): CardNode {
  return {
    t: "ticker", symbol: c.symbol.slice(0, 16), name: c.name.slice(0, 60), price: money(c.price, cur, o.compact).slice(0, 40),
    change: pct(c.percent), tone: tone(c.percent),
    ...(c.points.length > 1 ? { points: thin(c.points, o.hero ? 60 : 40) } : {}),
    ...(o.hero ? { hero: true, ...(weekNote(c, cur) ? { note: weekNote(c, cur) } : {}) } : {}),
  } as CardNode;
}

/** The Watchlist: a row per coin (the first one large on tall tiles), the coins CoinGecko did not know, and the source. */
export function listCard(s: Snapshot, tile: Tile = { w: 2, h: 2 }): CardData {
  const p = plan(tile, s.coins.length + s.missing.length);
  const compact = tile.w < 4;
  const rows: CardNode[] = s.coins.slice(0, p.rows).map((c, i) => tickerOf(c, s.currency, { compact: p.hero && i === 0 ? false : compact, hero: p.hero && i === 0 }));
  for (const id of s.missing.slice(0, Math.max(0, p.rows - rows.length))) rows.push({ t: "row", gap: 1, align: "between", children: [text(id, { bold: true }), text("not found on CoinGecko", { size: "s", tone: "muted" })] } as CardNode);
  return card({ t: "col", gap: 0, grow: true, children: [...rows, (p.footer || s.error) && footer(s)].filter(Boolean) });
}

/** The Price tile (stat): the coin's price with its sign, its name, the 24-hour change, and the week for the chart style. */
export function priceStat(c: Coin, cur: string): { value: string; label: string; delta: number; points?: number[] } {
  return { value: money(c.price, cur, c.price >= 1e6), label: c.name, delta: Math.round(c.percent * 100) / 100, ...(c.points.length > 1 ? { points: thin(c.points, 60) } : {}) };
}
