# spawnwatcher

Watches the [models.dev](https://models.dev) catalog for new and updated LLM models, publishes a public news feed, and pushes structured release messages to a downstream server.

Live at [feed.spawnstudio.cc](https://feed.spawnstudio.cc).

## How it works

- Polls `models.dev/api.json` and diffs consecutive captures. A new model id becomes a `model_added` event; a changed cost, limit, or modality set becomes `model_updated`. Watched providers: Anthropic, OpenAI, Google, xAI, Perplexity, OpenRouter.
- Events become feed items: a blurb written by Gemini (templated fallback without an API key) and a structured summary built from catalog data.
- Items are pushed to the downstream server as an authenticated webhook. Ids are content-derived and the receiver upserts, so redelivery is harmless; failures retry with capped backoff.
- State is a single SQLite file.

## Endpoints

| Path | Content |
|---|---|
| `/` | Rendered feed |
| `/feed.json` | JSON Feed 1.1 |
| `/rss.xml` | RSS 2.0 |
| `/healthz` | Health check |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `DB_PATH` | `./data/spawnwatcher.db` | SQLite file location |
| `PUBLIC_URL` | `https://feed.spawnstudio.cc` | Origin used in feed links |
| `SPAWN_WEBHOOK_URL` | — | Downstream server; unset disables delivery |
| `SPAWNWATCHER_TOKEN` | — | Bearer token for the webhook |
| `GEMINI_API_KEY` | — | Gemini-written blurbs; unset uses templated text |
| `GEMINI_MODEL` | `gemini-flash-latest` | Gemini model id |
| `POLL_INTERVAL` | `30m` | Polling cadence |
| `MAX_DIFF_AGE` | `168h` | Older captures reseed instead of diffing |

## Development

```sh
npm install
npm run check   # eslint, type check, tests, build
npm run dev     # run locally on :8080
```

`node dist/main.js backfill [days]` seeds a fresh database from the catalog's release dates.

## License

MIT
