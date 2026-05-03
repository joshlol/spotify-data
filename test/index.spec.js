import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src';

// Helper to build a mock env with KV and secrets store stubs
function mockEnv(overrides = {}) {
	const kvStore = new Map();
	return {
		SPOTIFY_CLIENT_ID: 'test-client-id',
		SPOTIFY_SECRET_ID: { get: async () => 'test-client-secret' },
		SPOTIFY_REFRESH_TOKEN: { get: async () => 'test-refresh-token' },
		SPOTIFY_TOKEN_KV: {
			get: async (key, opts) => {
				const val = kvStore.get(key);
				if (!val) return null;
				return opts?.type === 'json' ? JSON.parse(val) : val;
			},
			put: async (key, value) => { kvStore.set(key, value); },
			delete: async (key) => { kvStore.delete(key); },
		},
		...overrides,
	};
}

describe('Spotify Worker', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('returns CORS headers on OPTIONS', async () => {
		const request = new Request('http://example.com', { method: 'OPTIONS' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
	});

	it('returns 405 for non-GET/OPTIONS methods', async () => {
		const request = new Request('http://example.com', { method: 'POST' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(405);
		expect(await response.text()).toBe('Method Not Allowed');
	});

	it('returns now playing data when a track is active', async () => {
		const testEnv = mockEnv();
		const originalFetch = globalThis.fetch;

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
			if (url === 'https://accounts.spotify.com/api/token') {
				return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (url === 'https://api.spotify.com/v1/me/player/currently-playing') {
				return new Response(JSON.stringify({
					is_playing: true,
					item: {
						name: 'Test Song',
						external_urls: { spotify: 'https://open.spotify.com/track/123' },
						artists: [{ name: 'Test Artist' }],
					},
				}), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(url, opts);
		});

		const request = new Request('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.playing).toBe(true);
		expect(body.name).toBe('Test Song');
		expect(body.artist).toBe('Test Artist');
		expect(body.formatted).toBe('Test Song by Test Artist');
	});

	it('returns playing:false when nothing is playing and nothing recent', async () => {
		const testEnv = mockEnv();

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (url === 'https://accounts.spotify.com/api/token') {
				return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (url === 'https://api.spotify.com/v1/me/player/currently-playing') {
				return new Response(null, { status: 204 });
			}
			if (url === 'https://api.spotify.com/v1/me/player/recently-played?limit=1') {
				return new Response(JSON.stringify({ items: [] }), { status: 200 });
			}
			return new Response(null, { status: 500 });
		});

		const request = new Request('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.playing).toBe(false);
		expect(body.recent).toBeUndefined();
	});

	it('returns recent:true when last play was within 30 minutes', async () => {
		const testEnv = mockEnv();
		const playedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (url === 'https://accounts.spotify.com/api/token') {
				return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (url === 'https://api.spotify.com/v1/me/player/currently-playing') {
				return new Response(null, { status: 204 });
			}
			if (url === 'https://api.spotify.com/v1/me/player/recently-played?limit=1') {
				return new Response(JSON.stringify({
					items: [
						{
							played_at: playedAt,
							track: {
								name: 'Past Song',
								external_urls: { spotify: 'https://open.spotify.com/track/abc' },
								artists: [{ name: 'Past Artist' }],
							},
						},
					],
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return new Response(null, { status: 500 });
		});

		const request = new Request('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.playing).toBe(false);
		expect(body.recent).toBe(true);
		expect(body.name).toBe('Past Song');
		expect(body.artist).toBe('Past Artist');
		expect(body.formatted).toBe('Past Song by Past Artist');
		expect(body.playedAt).toBe(playedAt);
	});

	it('returns playing:false when last play was over 30 minutes ago', async () => {
		const testEnv = mockEnv();
		const playedAt = new Date(Date.now() - 45 * 60 * 1000).toISOString();

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (url === 'https://accounts.spotify.com/api/token') {
				return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (url === 'https://api.spotify.com/v1/me/player/currently-playing') {
				return new Response(null, { status: 204 });
			}
			if (url === 'https://api.spotify.com/v1/me/player/recently-played?limit=1') {
				return new Response(JSON.stringify({
					items: [
						{
							played_at: playedAt,
							track: {
								name: 'Old Song',
								external_urls: { spotify: 'https://open.spotify.com/track/xyz' },
								artists: [{ name: 'Old Artist' }],
							},
						},
					],
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return new Response(null, { status: 500 });
		});

		const request = new Request('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.playing).toBe(false);
		expect(body.recent).toBeUndefined();
	});

	it('returns playing:false when recently-played returns 403 (missing scope)', async () => {
		const testEnv = mockEnv();

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (url === 'https://accounts.spotify.com/api/token') {
				return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (url === 'https://api.spotify.com/v1/me/player/currently-playing') {
				return new Response(null, { status: 204 });
			}
			if (url === 'https://api.spotify.com/v1/me/player/recently-played?limit=1') {
				return new Response('Forbidden', { status: 403 });
			}
			return new Response(null, { status: 500 });
		});

		const request = new Request('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.playing).toBe(false);
		expect(body.error).toBeUndefined();
	});

	it('returns error when Spotify API fails', async () => {
		const testEnv = mockEnv();

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (url === 'https://accounts.spotify.com/api/token') {
				return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (url === 'https://api.spotify.com/v1/me/player/currently-playing') {
				return new Response('Internal Server Error', { status: 500 });
			}
			return new Response(null, { status: 500 });
		});

		const request = new Request('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		const body = await response.json();
		expect(body.playing).toBe(false);
		expect(body.error).toBeDefined();
	});
});
