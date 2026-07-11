const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_BYTES = 256 * 1024;

function clone(value) {
  return structuredClone(value);
}

export function evidenceCacheKey({ sourceId, sourcePolicyVersion, scoreVersion, network, address }) {
  const parts = [sourceId, sourcePolicyVersion, scoreVersion, network, address?.toLowerCase()];
  if (parts.some((part) => typeof part !== "string" || part.length === 0)) throw new TypeError("cache key fields must be non-empty strings");
  return JSON.stringify(parts);
}

export function createEvidenceCache({ now = Date.now, maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const entries = new Map();
  const flights = new Map();

  function get(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry);
    return clone(entry.value);
  }

  function put(key, loaded) {
    if (!loaded || loaded.cacheable === false || !Number.isFinite(loaded.expiresAt) || loaded.expiresAt <= now() || loaded.value === null || loaded.value === undefined) return;
    let serialized;
    try {
      serialized = JSON.stringify(loaded.value);
    } catch {
      return;
    }
    if (Buffer.byteLength(serialized) > maxBytes) return;
    entries.delete(key);
    entries.set(key, { value: clone(loaded.value), expiresAt: loaded.expiresAt });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  async function getOrLoad(key, loader) {
    const hit = get(key);
    if (hit !== undefined) return hit;
    if (!flights.has(key)) {
      flights.set(key, Promise.resolve().then(loader).then((loaded) => {
        put(key, loaded);
        return clone(loaded?.value);
      }).finally(() => flights.delete(key)));
    }
    return clone(await flights.get(key));
  }

  return {
    getOrLoad,
    has: (key) => get(key) !== undefined,
    get size() { return entries.size; },
  };
}
