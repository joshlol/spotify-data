# spotify-data

A simple service to fetch your Spotify listening data using the Spotify Web API.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fjoshlol%2Fspotify-data)

## Features

- Retrieve your currently playing track
- Edge caching using Cloudflare Workers KV

## Prerequisites

- Node.js (v20+)
- npm or Yarn
- A Spotify Developer account with a registered application to obtain:
  - `SPOTIFY_CLIENT_ID`
  - `SPOTIFY_SECRET_ID`
  - `SPOTIFY_REFRESH_TOKEN`

## Installation

1. Clone this repository:

   ```bash
   git clone https://github.com/Wist9063/spotify-data.git
   cd spotify-data
   ```

2. Install dependencies:

   ```bash
   npm install
   # or
   yarn install
   ```

## Configuration

Create a `.env` file or set environment variables in your deployment platform:

```bash
SPOTIFY_CLIENT_ID=<your-client-id>
SPOTIFY_SECRET_ID=<your-client-secret>
SPOTIFY_REFRESH_TOKEN=<your-refresh-token>
```

If deploying to Cloudflare Workers with Wrangler, add these to your `wrangler.toml` under `vars` and/or `secrets_store_secrets`.

## Usage

### Local Development

```bash
# Start the development server (Next.js or your chosen framework)
npm run dev
```

Visit `http://localhost:3000/api/spotify` to see the JSON payload.

- `?redirect` — redirect to the Spotify track URL  

### Deployment

You can deploy this service to any Node.js host or edge platform. For Cloudflare Workers:

1. Install Wrangler:

   ```bash
   npm install -g @cloudflare/wrangler
   ```

2. Configure `wrangler.toml` with your KV namespace and environment bindings.
3. Publish:

   ```bash
   wrangler publish
   ```

## API Endpoints

- `GET /api/spotify`  
  Returns JSON with your current Spotify playback status.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
