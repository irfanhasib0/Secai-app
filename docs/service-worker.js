const CACHE_VERSION = 'nvr-pwa-v4';
const INDEX_URL = './index.html';
const APP_SHELL = [
  './',
  INDEX_URL,
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './screenshot-wide.png',
  './screenshot-mobile.png',
];

const ASSET_MANIFEST_URL = './asset-manifest.json';

const isApiRequest = (url) => (
  url.pathname.startsWith('/api/') ||
  url.pathname.includes('/api/')
);

const isStaticAsset = (url) => url.pathname.includes('/static/');

const normalizeCachePath = (value) => {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      return new URL(raw).pathname;
    } catch (_error) {
      return null;
    }
  }
  return raw.startsWith('/') ? `.${raw}` : raw;
};

const getManifestEntrypoints = async () => {
  try {
    const response = await fetch(ASSET_MANIFEST_URL, { cache: 'no-cache' });
    if (!response.ok) {
      return [];
    }
    const manifest = await response.json();
    const entrypoints = Array.isArray(manifest?.entrypoints)
      ? manifest.entrypoints
      : [];
    return entrypoints
      .map(normalizeCachePath)
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
};

const notifyClients = (message) => {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((clients) => {
      clients.forEach((client) => client.postMessage(message));
    });
};

const cacheResponseIfChanged = async (cache, request, response) => {
  if (!response || !response.ok) {
    return false;
  }

  const cached = await cache.match(request);
  if (cached) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/') || contentType.includes('javascript') || contentType.includes('json')) {
      const [cachedText, nextText] = await Promise.all([
        cached.clone().text(),
        response.clone().text(),
      ]);
      if (cachedText === nextText) {
        return false;
      }
    }
  }

  await cache.put(request, response.clone());
  return true;
};

const refreshAppShell = async () => {
  const cache = await caches.open(CACHE_VERSION);
  const response = await fetch(INDEX_URL, { cache: 'no-cache' });
  const changed = await cacheResponseIfChanged(cache, INDEX_URL, response);
  if (changed) {
    notifyClients({ type: 'NVR_APP_SHELL_UPDATED' });
  }
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(async (cache) => {
        const entrypoints = await getManifestEntrypoints();
        const precacheList = Array.from(new Set([...APP_SHELL, ...entrypoints]));
        await cache.addAll(precacheList);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isApiRequest(url)) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_VERSION)
        .then(async (cache) => {
          const cached = await cache.match(INDEX_URL);
          const refresh = refreshAppShell();
          event.waitUntil(refresh.catch(() => undefined));

          if (cached) {
            return cached;
          }

          try {
            const response = await fetch(request, { cache: 'no-cache' });
            await cacheResponseIfChanged(cache, INDEX_URL, response.clone());
            return response;
          } catch (_error) {
            const fallback = await cache.match(INDEX_URL);
            if (fallback) {
              return fallback;
            }
            return Response.error();
          }
        })
        .catch(async () => {
          const fallback = await caches.match(INDEX_URL);
          return fallback || Response.error();
        })
    );
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) {
          return cached;
        }

        return fetch(request)
          .then((response) => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => Response.error());
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        fetch(request, { cache: 'no-cache' })
          .then((response) => caches.open(CACHE_VERSION)
            .then((cache) => cacheResponseIfChanged(cache, request, response)))
          .catch(() => undefined);
        return cached;
      }

      return fetch(request, { cache: 'no-cache' })
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => Response.error());
    })
  );
});
