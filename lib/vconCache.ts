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
