/**
 * Cloudflare Worker to proxy Spotify “currently playing” data.
 * - Uses Workers KV for token caching (binding: SPOTIFY_TOKEN_KV)
 * - Reads SPOTIFY_CLIENT_ID from vars, SPOTIFY_SECRET_ID & SPOTIFY_REFRESH_TOKEN from Secrets Store
 * - Handles CORS preflight and GET requests
 */

export default {
  async fetch(request, env, ctx) {
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

    try {
      const clientID     = env.SPOTIFY_CLIENT_ID;
      const clientSecret = await env.SPOTIFY_SECRET_ID.get();
      const refreshToken = await env.SPOTIFY_REFRESH_TOKEN.get();   

      if (!clientID || !clientSecret || !refreshToken) {
        return new Response(JSON.stringify({ playing: false, error: 'Missing credentials' }), {
          status: 500,
          headers: CORS,
        });
      }

      let tokenData = await env.SPOTIFY_TOKEN_KV.get('spotify_token', { type: 'json' });
      let accessToken;
      if (tokenData && Date.now() < tokenData.expiresAt) {
        accessToken = tokenData.token;
      } else {
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
        accessToken = access_token;
      }

      const nowRes = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      if (nowRes.status === 204) {
        return new Response(JSON.stringify({ playing: false }), { headers: CORS });
      }
      if (!nowRes.ok) {
        const err = await nowRes.text();
        throw new Error(`Now playing fetch failed: ${nowRes.status} ${err}`);
      }
      const data = await nowRes.json();
      const item = data.item;
      return new Response(JSON.stringify({
        playing: true,
        name:     item.name,
        url:      item.external_urls.spotify,
        artist:   item.artists[0].name,
        formatted: `${item.name} by ${item.artists[0].name}`,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });

    } catch (e) {
      console.error('Spotify Worker Error:', e);
      return new Response(JSON.stringify({ playing: false, error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }
  }
};