# spotify-data

A Cloudflare Worker that exposes your Spotify "currently playing" data via HTTP and Workers RPC.

## Features

- Retrieve your currently playing track
- Access token caching via Cloudflare Workers KV
- RPC entrypoint (`SpotifyService`) for service binding from other workers
- Standalone HTTP endpoint with CORS support

## Prerequisites

- Node.js (v20+)
- A Cloudflare account
- A Spotify Developer account with a registered application to obtain:
  - `SPOTIFY_CLIENT_ID`
  - `SPOTIFY_SECRET_ID`
  - `SPOTIFY_REFRESH_TOKEN`

## Configuration

Set `SPOTIFY_CLIENT_ID` as a var in `wrangler.jsonc`. Store `SPOTIFY_SECRET_ID` and `SPOTIFY_REFRESH_TOKEN` in Cloudflare Secrets Store and bind them in `wrangler.jsonc` under `secrets_store_secrets`.

A KV namespace (`SPOTIFY_TOKEN_KV`) is required for caching access tokens.

## Usage

### Local Development

```bash
npm run dev
```

Sends requests to Spotify's API using your configured credentials. Requires `--remote` for secrets store access:

```bash
npx wrangler dev --remote
```

Then visit `http://localhost:8787` to see the JSON response.

### Deployment

```bash
npm run deploy
```

### RPC (Service Binding)

To call this worker from another Cloudflare Worker via RPC, add a service binding in the caller's `wrangler.jsonc`:

```jsonc
"services": [
  {
    "binding": "SPOTIFY_WORKER",
    "service": "xxx-spotify-data", // replace with your worker's name
    "entrypoint": "SpotifyService"
  }
]
```

Then call it directly:

```js
const data = await env.SPOTIFY_WORKER.getNowPlaying()
// { playing: true, name: '...', artist: '...', url: '...', formatted: '...' }
// or { playing: false }
// or { playing: false, error: '...' }
```

### HTTP Endpoint

- `GET /` — Returns JSON with your current Spotify playback status.

#### Response

```json
{
  "playing": true,
  "name": "Track Name",
  "artist": "Artist Name",
  "url": "https://open.spotify.com/track/...",
  "formatted": "Track Name by Artist Name"
}
```

When nothing is playing:

```json
{
  "playing": false
}
```

## Testing

```bash
npm test
```

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
