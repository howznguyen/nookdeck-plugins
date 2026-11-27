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

/** 61,327 / 0.4521 / 0.00001234; compact (1.6B) when asked and the number is large. */
export function price(n: number, compact = false): string {
  const a = Math.abs(n);
  if (compact && a >= 1e6) return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
  if (a >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (a >= 1) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a === 0) return "0";
  return n.toPrecision(4).replace(/0+$/, "");
}
/** The price with its currency sign: "$61,327", "1,602,345,000₫". */
export function money(n: number, cur: string, compact = false): string {
  const s = SIGN[cur];
  const p = price(n, compact);
  if (!s) return `${p} ${cur.toUpperCase()}`;
  return cur === "vnd" ? `${p}${s}` : `${s}${p}`;
}
export const pct = (n: number): string => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;
const tone = (n: number) => (n > 0 ? "ok" : n < 0 ? "bad" : "muted");

/** A card sparkline takes up to 60 points: the week's ~168 hourly prices, every nth one, always ending on the latest. */
export function thin(points: number[], max = 56): number[] {
  if (points.length <= max) return points;
  const step = points.length / max;
  return Array.from({ length: max }, (_, i) => points[Math.round(points.length - 1 - (max - 1 - i) * step)]!);
}

export function message(lines: string[], icon = "alert-triangle"): CardData {
  return card({ t: "col", gap: 1, align: "center", grow: true, children: [{ t: "icon", name: icon, tone: "muted" }, ...lines.map((l, i) => text(l, { size: "s", tone: i ? "muted" : "default" }))] });
}

const footer = (s: Snapshot): CardNode => text(`24h · ${s.currency.toUpperCase()} · CoinGecko${s.error ? ` · ${s.error}` : ""}`, { size: "s", tone: s.error ? "warn" : "muted" });

/** Every coin on a row: ticker, price, 24-hour change; the 7-day sparkline on tiles 4 wide. */
export function listCard(s: Snapshot, tile: Tile = { w: 2, h: 2 }): CardData {
  const wide = tile.w >= 4;
  const rows: CardNode[] = s.coins.map((c) => ({ t: "row", gap: 1, align: "between", children: [
    text(c.symbol, { bold: true }),
    wide && c.points.length > 1 && ({ t: "sparkline", points: thin(c.points), tone: tone(c.percent) } as CardNode),
    text(money(c.price, s.currency, !wide)),
    { t: "pill", text: pct(c.percent), tone: tone(c.percent) },
  ].filter(Boolean) }) as CardNode);
  for (const id of s.missing) rows.push({ t: "row", gap: 1, align: "between", children: [text(id, { bold: true }), text("not found on CoinGecko", { size: "s", tone: "muted" })] } as CardNode);
  return card({ t: "col", gap: 1, grow: true, children: [...rows, footer(s)] });
}
