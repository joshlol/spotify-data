# spotify-data

A Cloudflare Worker that exposes your Spotify "currently playing" data via HTTP and Workers RPC.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/joshlol/spotify-data)

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

This project requires a [Spotify Developer application](https://developer.spotify.com/dashboard) with the following credentials:

| Variable | Where to set |
|---|---|
| `SPOTIFY_CLIENT_ID` | `vars` in `wrangler.jsonc` |
| `SPOTIFY_SECRET_ID` | Cloudflare Secrets Store (set during deploy) |
| `SPOTIFY_REFRESH_TOKEN` | Cloudflare Secrets Store (set during deploy) |

A KV namespace (`SPOTIFY_TOKEN_KV`) is automatically provisioned on deploy.

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

This project is licensed under the GNU General Public License v3.0. See the [LICENSE](LICENSE) file for details.
