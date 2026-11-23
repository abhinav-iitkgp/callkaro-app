/* CallKaro offline service worker.
   - Precaches the whole app (page, script, fonts, icons) and the sample call recordings.
   - Serves everything cache-first so the installed app opens with no connection.
   - Answers Range requests from cache (Safari needs 206 responses to play audio).
   - This build has no backend on its own origin: same-origin /api/* calls are answered
     instantly so the app drops straight to its built-in on-device behaviour. */
const VERSION = "988a0f615765";
const CORE = ["_expo/static/js/web/index-a0203dc35e7d8fcb5bbbf1e1e70e592f.js","assets/assets/fonts/PlusJakartaSans-Bold.bac8ecad2d6da4aa6b4200699a80a9dd.ttf","assets/assets/fonts/PlusJakartaSans-Medium.0a825b3e08f62af5a9bc9130843b12ff.ttf","assets/assets/fonts/PlusJakartaSans-Regular.dd3a1370a03dc0f2d7d093bd0ffe7c0b.ttf","assets/assets/fonts/PlusJakartaSans-SemiBold.73de6fb49299ccb6478575127008c120.ttf","assets/assets/logo-mark.f05aee896f233a3160b00a5d71c137f2.png","assets/vendor/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Feather.a76d309774d33d9856f650bed4292a23.ttf","favicon.ico","icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","index.html","manifest.webmanifest"];
const MEDIA = ["api/audio/call-1.wav","api/audio/call-2.wav","api/audio/call-3.wav","api/audio/call-4.wav","api/audio/call-salon-1.wav"];
const AUDIO_DIR = 'api/audio/'; // where the recordings live in this build

const APP_CACHE = 'callkaro-app-' + VERSION;
const MEDIA_CACHE = 'callkaro-media-v1';
const BASE = new URL(self.registration.scope).pathname; // ends with "/"
const abs = (p) => new URL(p, self.registration.scope).toString();

async function precacheMedia() {
  const cache = await caches.open(MEDIA_CACHE);
  await Promise.allSettled(
    MEDIA.map(async (p) => {
      if (await cache.match(abs(p))) return;
      const res = await fetch(abs(p), { cache: 'no-cache' });
      if (res.ok) await cache.put(abs(p), res);
    })
  );
}

let mediaJob = null;
function ensureMedia() {
  if (!mediaJob) mediaJob = precacheMedia().finally(() => { mediaJob = null; });
  return mediaJob;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      await Promise.all(
        CORE.map(async (p) => {
          const res = await fetch(abs(p), { cache: 'reload' });
          if (!res.ok) throw new Error('precache failed: ' + p);
          await cache.put(abs(p), res);
        })
      );
      await ensureMedia();
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('callkaro-app-') && k !== APP_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

async function status() {
  const app = await caches.open(APP_CACHE);
  const media = await caches.open(MEDIA_CACHE);
  let cached = 0;
  for (const p of CORE) if (await app.match(abs(p))) cached++;
  for (const p of MEDIA) if (await media.match(abs(p))) cached++;
  return { version: VERSION, cached, total: CORE.length + MEDIA.length };
}

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'status') {
    event.waitUntil(
      (async () => {
        let s = await status();
        if (s.cached < s.total) {
          await ensureMedia();
          s = await status();
        }
        if (event.source) event.source.postMessage({ type: 'status', ...s });
      })()
    );
  }
});

function standaloneApiResponse() {
  return new Response(JSON.stringify({ error: 'standalone', message: 'No server in this build' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function fromCaches(url) {
  return (
    (await (await caches.open(APP_CACHE)).match(url, { ignoreSearch: true })) ||
    (await (await caches.open(MEDIA_CACHE)).match(url, { ignoreSearch: true }))
  );
}

async function withRange(request, response) {
  const header = request.headers.get('range');
  if (!header || !response || response.status !== 200) return response;
  const m = /bytes=(\d*)-(\d*)/.exec(header);
  if (!m) return response;
  const buf = await response.arrayBuffer();
  const size = buf.byteLength;
  let start;
  let end;
  if (m[1] === '' && m[2] !== '') {
    start = Math.max(0, size - parseInt(m[2], 10));
    end = size - 1;
  } else {
    start = m[1] === '' ? 0 : parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

async function cacheFirst(request, url, cacheName) {
  const hit = await fromCaches(url);
  if (hit) return withRange(request, hit);
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (res.ok && res.status === 200) {
      const copy = res.clone();
      caches.open(cacheName).then((c) => c.put(url, copy)).catch(() => {});
      return withRange(request, res);
    }
    return res;
  } catch (e) {
    return new Response('Offline', { status: 504, headers: { 'Content-Type': 'text/plain' } });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;
  const rel = url.pathname.slice(BASE.length);

  if (rel.startsWith('api/audio/')) {
    if (request.method !== 'GET') return;
    const mapped = abs(AUDIO_DIR + rel.slice('api/audio/'.length));
    event.respondWith(cacheFirst(request, mapped, MEDIA_CACHE));
    return;
  }
  if (rel.startsWith('api/')) {
    event.respondWith(standaloneApiResponse());
    return;
  }
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => (await fromCaches(abs('index.html'))) || fetch(request).catch(() => fromCaches(abs('index.html'))))()
    );
    return;
  }
  event.respondWith(cacheFirst(request, url.origin + url.pathname, rel.startsWith(AUDIO_DIR) ? MEDIA_CACHE : APP_CACHE));
});
