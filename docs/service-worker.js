const CACHE_VERSION = 'nvr-pwa-v5';
const RECORDING_CACHE_LIMIT = 25;
const RECORDING_CACHE_NAMES = {
  thumbnails: 'nvr-recording-thumbnails-v1',
  videos: 'nvr-recording-videos-v1',
  motion: 'nvr-recording-motion-v1',
  personImages: 'nvr-person-images-v1',
};
const ACTIVE_CACHE_NAMES = new Set([
  CACHE_VERSION,
  ...Object.values(RECORDING_CACHE_NAMES),
]);
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

const recordingRequestType = (url) => {
  if (/\/api\/persons\/[^/]+\/[^/]+\/image\/?$/.test(url.pathname)) return 'personImages';
  if (/\/api\/recordings\/[^/]+\/thumbnail\/?$/.test(url.pathname)) return 'thumbnails';
  if (/\/api\/recordings\/[^/]+\/play\/?$/.test(url.pathname)) return 'videos';
  if (/\/api\/recordings\/[^/]+\/motion-data\/?$/.test(url.pathname)) return 'motion';
  return null;
};

const isCacheableResponse = (response) => (
  response && (response.ok || response.type === 'opaque') && response.status !== 206
);

// Cache Storage preserves insertion order. Reinsert hits and trim the oldest
// keys to provide a small LRU cache without adding another persistence layer.
const storeBoundedResponse = async (cacheName, request, response) => {
  if (!isCacheableResponse(response)) return;
  const cache = await caches.open(cacheName);
  await cache.delete(request);
  const existingKeys = await cache.keys();
  const requiredEvictions = Math.max(0, existingKeys.length - RECORDING_CACHE_LIMIT + 1);
  if (requiredEvictions > 0) {
    await Promise.all(existingKeys
      .slice(0, requiredEvictions)
      .map((key) => cache.delete(key)));
  }
  await cache.put(request, response);
  const keys = await cache.keys();
  const excess = keys.length - RECORDING_CACHE_LIMIT;
  if (excess > 0) {
    await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
  }
};

const serveBoundedRecordingCache = async (event, request, cacheName, stripRange = false) => {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) {
    try {
      await storeBoundedResponse(cacheName, request, cached.clone());
    } catch (_error) {
      // A cache maintenance failure must not prevent playback of a cache hit.
    }
    return cached;
  }

  let networkRequest = request;
  if (stripRange && request.headers.has('range')) {
    const headers = new Headers(request.headers);
    headers.delete('range');
    networkRequest = new Request(request, { headers });
  }

  const response = await fetch(networkRequest);
  if (isCacheableResponse(response)) {
    event.waitUntil(
      storeBoundedResponse(cacheName, request, response.clone()).catch(() => undefined)
    );
  }
  return response;
};

const clearRecordingCaches = () => Promise.all(
  Object.values(RECORDING_CACHE_NAMES).map((cacheName) => caches.delete(cacheName))
);

const removeRecordingFromCaches = async (recordingId) => {
  const encodedId = encodeURIComponent(recordingId);
  const pathMarkers = [
    `/api/recordings/${encodedId}/`,
    `/api/persons/${encodedId}/`,
  ];
  await Promise.all(Object.values(RECORDING_CACHE_NAMES).map(async (cacheName) => {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    await Promise.all(keys
      .filter((request) => {
        const pathname = new URL(request.url).pathname;
        return pathMarkers.some((pathMarker) => pathname.includes(pathMarker));
      })
      .map((request) => cache.delete(request)));
  }));
};

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
          .filter((key) => !ACTIVE_CACHE_NAMES.has(key))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'NVR_CLEAR_RECORDING_CACHES') {
    event.waitUntil(clearRecordingCaches());
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  const requestUrl = new URL(request.url);

  if (request.method === 'DELETE') {
    const deleteMatch = requestUrl.pathname.match(/\/api\/recordings\/([^/]+)\/?$/);
    if (deleteMatch) {
      event.respondWith(fetch(request).then((response) => {
        if (response.ok) {
          event.waitUntil(removeRecordingFromCaches(decodeURIComponent(deleteMatch[1])));
        }
        return response;
      }));
    }
    return;
  }

  if (request.method !== 'GET') {
    return;
  }

  const recordingType = recordingRequestType(requestUrl);
  if (recordingType) {
    event.respondWith(serveBoundedRecordingCache(
      event,
      request,
      RECORDING_CACHE_NAMES[recordingType],
      recordingType === 'videos',
    ));
    return;
  }

  const url = requestUrl;
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
