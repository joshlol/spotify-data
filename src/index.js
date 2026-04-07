import { WorkerEntrypoint } from 'cloudflare:workers'

let tokenInflight = null;

async function getAccessToken(env) {
  if (tokenInflight) return tokenInflight;
  tokenInflight = _getAccessToken(env);
  try { return await tokenInflight; } finally { tokenInflight = null; }
}

async function _getAccessToken(env) {
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

  const auth = btoa(`${clientID}:${clientSecret}`);
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

async function invalidateAccessToken(env) {
  await env.SPOTIFY_TOKEN_KV.delete('spotify_token');
  tokenInflight = null;
}

const NOW_PLAYING_CACHE_TTL = 4000;
let inflight = null;

async function fetchNowPlaying(env) {
  if (inflight) return inflight;
  inflight = _fetchNowPlaying(env);
  try { return await inflight; } finally { inflight = null; }
}

/**
 * Fetches the currently playing track from Spotify.
 * Always returns a result object — never throws.
 */
async function _fetchNowPlaying(env) {
  try {
    const cached = await env.SPOTIFY_TOKEN_KV.get('now_playing', { type: 'json' });
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }

    const result = await _spotifyNowPlaying(env);

    if (result.playing) {
      await env.SPOTIFY_TOKEN_KV.put(
        'now_playing',
        JSON.stringify({ data: result, expiresAt: Date.now() + NOW_PLAYING_CACHE_TTL }),
        { expirationTtl: 60 }
      );
    }

    return result;
  } catch (e) {
    console.error('Spotify Worker Error:', e);
    return { playing: false, error: e.message };
  }
}

async function _spotifyNowPlaying(env, retried = false) {
  const accessToken = await getAccessToken(env);

  const nowRes = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  if (nowRes.status === 401 && !retried) {
    await invalidateAccessToken(env);
    return _spotifyNowPlaying(env, true);
  }

  if (nowRes.status === 204) {
    return { playing: false };
  }
  if (!nowRes.ok) {
    const err = await nowRes.text();
    throw new Error(`Now playing fetch failed: ${nowRes.status} ${err}`);
  }

  const data = await nowRes.json();
  const item = data.item;

  if (!item) {
    return { playing: false };
  }

  return {
    playing: true,
    name:     item.name,
    url:      item.external_urls.spotify,
    artist:   item.artists[0].name,
    formatted: `${item.name} by ${item.artists[0].name}`,
  };
}

/**
 * RPC entrypoint — called via service binding from the main site worker.
 */
export class SpotifyService extends WorkerEntrypoint {
  async getNowPlaying() {
    return fetchNowPlaying(this.env);
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

/**
 * Default fetch handler for standalone HTTP access.
 */
export default {
  async fetch(request, env) {

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
