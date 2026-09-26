import { WorkerEntrypoint } from 'cloudflare:workers'

// Cloudflare-generated upstream errors return only "error code: 52x" as the body
const CF_ERRORS = {
  520: 'Spotify returned an unknown error',
  521: 'Spotify refused the connection',
  522: 'connection to Spotify timed out',
  523: 'Spotify is unreachable',
  524: 'Spotify took too long to respond',
  525: 'TLS handshake with Spotify failed',
  526: 'Spotify presented an invalid TLS certificate',
};

async function spotifyFetch(stage, url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new Error(`Spotify ${stage} request failed: ${e.message}`);
  }
}

async function upstreamError(stage, res) {
  const body = await res.text();
  let detail;
  try {
    const json = JSON.parse(body);
    detail = json.error_description || json.error?.message || (typeof json.error === 'string' ? json.error : undefined);
  } catch {}
  const text = body.trim();
  detail ??= CF_ERRORS[res.status] ?? (text && !text.startsWith('<') ? text.slice(0, 200) : 'unexpected response');
  return new Error(`Spotify ${stage} request failed (${res.status}): ${detail}`);
}

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

  const missing = Object.entries({
    SPOTIFY_CLIENT_ID: clientID,
    SPOTIFY_SECRET_ID: clientSecret,
    SPOTIFY_REFRESH_TOKEN: refreshToken,
  }).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(`Missing credentials: ${missing.join(', ')}`);
  }

  let tokenData = await env.SPOTIFY_TOKEN_KV.get('spotify_token', { type: 'json' });
  if (tokenData && Date.now() < tokenData.expiresAt) {
    return tokenData.token;
  }

  const auth = btoa(`${clientID}:${clientSecret}`);
  const tokenRes = await spotifyFetch('token', 'https://accounts.spotify.com/api/token', {
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
  if (!tokenRes.ok) throw await upstreamError('token', tokenRes);
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
const RECENT_WINDOW_MS = 30 * 60 * 1000;

async function _fetchNowPlaying(env) {
  try {
    const cached = await env.SPOTIFY_TOKEN_KV.get('now_playing', { type: 'json' });
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }

    const result = await _spotifyNowPlaying(env);

    if (result.playing || result.recent) {
      await env.SPOTIFY_TOKEN_KV.put(
        'now_playing',
        JSON.stringify({ data: result, expiresAt: Date.now() + NOW_PLAYING_CACHE_TTL }),
        { expirationTtl: 60 }
      );
    }

    return result;
  } catch (e) {
    console.error('Spotify Worker Error:', e.message);
    return { playing: false, error: e.message };
  }
}

async function _spotifyNowPlaying(env, retried = false) {
  const accessToken = await getAccessToken(env);

  const nowRes = await spotifyFetch('now-playing', 'https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  if (nowRes.status === 401 && !retried) {
    await invalidateAccessToken(env);
    return _spotifyNowPlaying(env, true);
  }

  if (nowRes.status === 204) {
    return _spotifyRecentlyPlayed(env, accessToken);
  }
  if (!nowRes.ok) throw await upstreamError('now-playing', nowRes);

  const data = await nowRes.json();
  const item = data.item;

  if (!item) {
    return _spotifyRecentlyPlayed(env, accessToken);
  }

  return {
    playing: true,
    name:     item.name,
    url:      item.external_urls.spotify,
    artist:   item.artists[0].name,
    albumImage: item.album?.images?.[0]?.url ?? null,
    formatted: `${item.name} by ${item.artists[0].name}`,
  };
}

async function _spotifyRecentlyPlayed(env, accessToken) {
  const res = await spotifyFetch('recently-played', 'https://api.spotify.com/v1/me/player/recently-played?limit=1', {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  if (res.status === 403) {
    console.warn('Spotify recently-played: 403 — refresh token likely missing user-read-recently-played scope');
    return { playing: false };
  }
  if (res.status === 204) {
    return { playing: false };
  }
  if (!res.ok) throw await upstreamError('recently-played', res);

  const data = await res.json();
  const entry = data.items?.[0];
  if (!entry?.track || !entry.played_at) {
    return { playing: false };
  }

  const playedAt = new Date(entry.played_at).getTime();
  if (!Number.isFinite(playedAt) || Date.now() - playedAt > RECENT_WINDOW_MS) {
    return { playing: false };
  }

  const item = entry.track;
  return {
    playing: false,
    recent: true,
    name:     item.name,
    url:      item.external_urls.spotify,
    artist:   item.artists[0].name,
    albumImage: item.album?.images?.[0]?.url ?? null,
    formatted: `${item.name} by ${item.artists[0].name}`,
    playedAt: entry.played_at,
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
