# Crypto price

Live coin prices from [CoinGecko](https://www.coingecko.com)'s free public API. No account or key. Works on macOS, Windows and Linux.

## Tiles

- **Watchlist**: one row per coin with the price and the 24-hour change, green or red. A 4-wide tile adds each coin's chart for the last 7 days. Up to 6 coins.
- **Price**: one coin as a large number (the `stat` tile), in USD. Put the CoinGecko id (`bitcoin`, `ethereum`) in the tile's settings. This tile is a plain `source` in `nookdeck.json`, without code, and is the smallest example to copy.

## Settings

- **Coins**: separated by commas. Common tickers work (`BTC, ETH, SOL, BNB, XRP, DOGE, TON`...). For any other coin use its CoinGecko id, the last part of its page address: coingecko.com/en/coins/**the-open-network**. A coin CoinGecko does not know shows "not found" on its row.
- **Currency**: USD, EUR, VND, JPY, GBP, AUD, CAD, SGD, KRW, INR or BRL. Large prices are shortened on a 2-wide tile (1.6B₫).

## How often it asks

One request covers every coin of the list, at most once a minute. CoinGecko's free API limits the requests a minute. After "too many requests" the plugin waits 3 minutes and keeps the last prices on the tile meanwhile. The last answer is saved, so a restart does not ask again at once.

## Access

`api.coingecko.com` (network) and storage (the last prices). No shell, no keyboard.
