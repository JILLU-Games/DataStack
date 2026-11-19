const CACHE_NAME = 'datastack-cache-v3';
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
];

function buildOfflineShellResponse(pathname) {
  const safePath = String(pathname || '/').replace(/[<>&"']/g, '');
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DataStack — Offline</title>
  <style>
    :root { color-scheme: dark light; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 16px;
      background: #0a0a0b;
      color: #f4f4f5;
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    }
    .panel {
      width: 100%;
      max-width: 360px;
      border: 1px solid #27272a;
      background: #111113;
      padding: 20px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    .mark {
      width: 10px;
      height: 10px;
      background: #10b981;
      display: inline-block;
    }
    h1 { font-size: 15px; margin: 0 0 8px; font-weight: 600; }
    p { font-size: 12.5px; line-height: 1.5; color: #a1a1aa; margin: 0 0 16px; }
    code { color: #e4e4e7; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11.5px; }
    .actions { display: flex; gap: 8px; }
    button, a {
      appearance: none;
      border: 1px solid #27272a;
      background: #18181b;
      color: #f4f4f5;
      padding: 7px 12px;
      font-size: 12px;
      text-decoration: none;
      cursor: pointer;
    }
    button.primary {
      border-color: #10b981;
      background: #10b981;
      color: #09090b;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <main class="panel">
    <div class="brand"><span class="mark"></span>DataStack</div>
    <h1>Network connection unavailable</h1>
    <p>Unable to reach <code>${safePath}</code> while offline. Live ingestion metrics and authenticated admin routes require a connection to the DataStack server.</p>
    <div class="actions">
      <button type="button" class="primary" onclick="window.location.reload()">Retry</button>
      <a href="/">Overview</a>
    </div>
  </main>
</body>
</html>`;

  return new Response(html, {
    status: 503,
    statusText: 'Service Unavailable',
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CLEAR_AUTH_CACHE') {
    event.waitUntil(
      caches.open(CACHE_NAME).then(async (cache) => {
        const requests = await cache.keys();
        await Promise.all(
          requests
            .filter((req) => {
              try {
                const reqUrl = new URL(req.url);
                return reqUrl.pathname === '/vcon' || reqUrl.pathname.startsWith('/vcon/');
              } catch {
                return false;
              }
            })
            .map((req) => cache.delete(req))
        );
      }).catch(() => {})
    );
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Only handle same-origin GET requests; never intercept WebSocket, HMR, or API routes
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/_next/webpack-hmr')
  ) {
    return;
  }

  // Never cache authenticated /vcon/* responses, but provide an offline HTML shell on PWA launch / navigation failure
  if (url.pathname === '/vcon' || url.pathname.startsWith('/vcon/')) {
    if (request.mode !== 'navigate') {
      return;
    }
    event.respondWith(
      fetch(request).catch(() => buildOfflineShellResponse(url.pathname))
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        const cacheControl = response.headers.get('Cache-Control') || '';
        const shouldSkipCache =
          cacheControl.includes('no-store') || cacheControl.includes('private');
        if (response && response.ok && response.type === 'basic' && !shouldSkipCache) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          return buildOfflineShellResponse(url.pathname);
        }
        return new Response('Offline — network unavailable.', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      })
  );
});
