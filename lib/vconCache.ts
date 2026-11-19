// In-memory Stale-While-Revalidate (SWR) cache for VCON Admin Control Panel views.
// Ensures 0ms instant state hydration when navigating across /vcon/* routes while
// silently refreshing live telemetry, clients, storage, settings, and profile data in the background.

const memoryStore = new Map<string, unknown>();

export function getCached<T>(key: string, fallback: T): T {
  if (memoryStore.has(key)) {
    return memoryStore.get(key) as T;
  }
  return fallback;
}

export function setCached<T>(key: string, value: T): T {
  memoryStore.set(key, value);
  return value;
}

export async function clearAuthCaches(): Promise<void> {
  memoryStore.clear();
  if (typeof window === 'undefined') return;
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_AUTH_CACHE' });
    }
    if ('caches' in window) {
      const keys = await window.caches.keys();
      await Promise.all(
        keys.map(async (cacheKey) => {
          const cache = await window.caches.open(cacheKey);
          const requests = await cache.keys();
          await Promise.all(
            requests
              .filter((req) => {
                try {
                  const u = new URL(req.url);
                  return u.pathname === '/vcon' || u.pathname.startsWith('/vcon/');
                } catch {
                  return false;
                }
              })
              .map((req) => cache.delete(req))
          );
        })
      );
    }
  } catch {
    // Best-effort cache cleanup
  }
}
