# Stocks

Price, change and today's chart for up to 4 symbols. The data comes from [Twelve Data](https://twelvedata.com) with your own free API key. Works on macOS, Windows and Linux.

## Getting a key

1. Sign up at twelvedata.com (the free plan is enough).
2. Copy the API key from your account page.
3. Paste it into this plugin's **Twelve Data API key** setting. It is stored as a secret.

Until a key is set, the tiles show a lock, "Add an API key" and where to put it.

## Tiles

- **Watchlist**: one row per symbol: the symbol and the company, the price with its currency sign, the change of the day as a green or red chip, and today's chart where the row is wide enough. On a 3-high tile the first symbol is a large row with a bigger chart. The last line says whether the market is open.
- **One symbol**: the price in large type, the change and today's chart, with the change in money and whether the market is open. A 2x1 tile shows one row. Pick the symbol in the tile's settings. It must be one of the plugin's symbols. Leave it empty to show the first one.

The tiles need Nookdeck 0.7.4 or later.

## How often it asks

Twelve Data's free plan limits the requests a minute and a day, and every symbol counts. The plugin asks for all symbols at once, in two requests (prices and today's 5-minute bars):

- every 5 minutes while a market is open;
- every 2 hours while all are closed;
- 15 minutes after "limit reached" or a refused key, keeping the last prices on the tile meanwhile.

The last answer is saved, so a restart does not ask again early. With 4 US symbols this is about 700 credits on a trading day. That fits the free plan's daily limit (800 when this was written) if this is the only thing using the key.

## Symbols

Use Twelve Data's symbols: `AAPL`, `MSFT`, `BTC/USD`, `EUR/USD`. Separate them with commas. Only the first 4 are used.

Vietnamese tickers (HOSE, HNX) are not supported yet: Twelve Data's exchange list has no Vietnamese exchange.

## Settings

| Setting | Default |
|---|---|
| Twelve Data API key | none |
| Symbols (up to 4, separated by commas) | AAPL, MSFT |

## Access

- `network`: api.twelvedata.com only.
- `storage`: the last answer, so a restart does not spend requests again.

No commands, no notifications.
