import { WorkerEntrypoint } from 'cloudflare:workers'

/**
 * Shared logic for fetching a Spotify access token, with KV caching.
 */
async function getAccessToken(env) {
  const clientID     = env.SPOTIFY_CLIENT_ID;
  const clientSecret = await env.SPOTIFY_SECRET_ID.get();
  const refreshToken = await env.SPOTIFY_REFRESH_TOKEN.get();

  if (!clientID || !clientSecret || !refreshToken) {
    throw new Error('Missing credentials');
  }

  let tokenData = await env.SPOTIFY_TOKEN_KV.get('spotify_token', { type: 'json' });
  if (tokenData && Date.now() < tokenData.expiresAt) {
    return tokenData.token;
  }

  const auth = Buffer.from(`${clientID}:${clientSecret}`).toString('base64');
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`,
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!tokenRes.ok) throw new Error(`Spotify token fetch failed: ${tokenRes.status}`);
  const { access_token, expires_in } = await tokenRes.json();
  const ttl = expires_in || 3600;
  await env.SPOTIFY_TOKEN_KV.put(
    'spotify_token',
    JSON.stringify({ token: access_token, expiresAt: Date.now() + (ttl - 60) * 1000 }),
    { expirationTtl: ttl }
  );
  return access_token;
}

/**
 * Fetches the currently playing track from Spotify.
 * Always returns a result object — never throws.
 */
async function fetchNowPlaying(env) {
  try {
    const accessToken = await getAccessToken(env);

    const nowRes = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (nowRes.status === 204) {
      return { playing: false };
    }
    if (!nowRes.ok) {
      const err = await nowRes.text();
      throw new Error(`Now playing fetch failed: ${nowRes.status} ${err}`);
    }
    const data = await nowRes.json();
    const item = data.item;
    return {
      playing: true,
      name:     item.name,
      url:      item.external_urls.spotify,
      artist:   item.artists[0].name,
      formatted: `${item.name} by ${item.artists[0].name}`,
    };
  } catch (e) {
    console.error('Spotify Worker Error:', e);
    return { playing: false, error: e.message };
  }
}

/**
 * RPC entrypoint — called via service binding from the main site worker.
 */
export class SpotifyService extends WorkerEntrypoint {
  async getNowPlaying() {
    return fetchNowPlaying(this.env);
  }
}

/**
 * Default fetch handler for standalone HTTP access.
 */
export default {
  async fetch(request, env) {
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }

    const result = await fetchNowPlaying(env);
    const status = result.error ? 500 : 200;
    return new Response(JSON.stringify(result), {
      status,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }
};
