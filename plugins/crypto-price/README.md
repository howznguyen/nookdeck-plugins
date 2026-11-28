# Crypto price

Live coin prices from [CoinGecko](https://www.coingecko.com)'s free public API. No account or key. Works on macOS, Windows and Linux.

## Tiles

- **Watchlist**: one row per coin: the ticker and the coin's name, the price with its currency sign, the 24-hour change as a green or red chip, and the week's chart where the row is wide enough. On a 4x3 tile the first coin is a large row with a bigger chart and the week's high and low. A 4x1 tile shows two coins. Up to 6 coins.
- **Price**: one coin as a large number (the `stat` tile) with its currency sign and the 24-hour change, in the plugin's currency. Put the coin (`BTC`, `ETH` or a CoinGecko id such as `bitcoin`) in the tile's settings. The chart style draws the week. When the Watchlist already has the coin, the tile uses its prices and asks CoinGecko nothing more.

The tiles need Nookdeck 0.7.4 or later.

## Settings

- **Coins**: separated by commas. Common tickers work (`BTC, ETH, SOL, BNB, XRP, DOGE, TON`...). For any other coin use its CoinGecko id, the last part of its page address: coingecko.com/en/coins/**the-open-network**. A coin CoinGecko does not know shows "not found" on its row.
- **Currency**: USD, EUR, VND, JPY, GBP, AUD, CAD, SGD, KRW, INR or BRL. Prices in đồng, yen and won have no cents. Large prices are shortened on a 2-wide tile (1.6B₫).

## How often it asks

One request covers every coin of the list, at most once a minute (a Price tile whose coin is not in the list asks for it on its own, also at most once a minute). CoinGecko's free API limits the requests a minute. After "too many requests" the plugin waits 3 minutes and keeps the last prices on the tile meanwhile. The last answer is saved, so a restart does not ask again at once.

## Access

`api.coingecko.com` (network) and storage (the last prices). No shell, no keyboard.
