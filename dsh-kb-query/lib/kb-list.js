/**
 * dsh-kb-query — KB list provider (pure factory, no I/O of its own).
 *
 * ONE source of truth for "which knowledge bases exist", shared by BOTH
 * backends (M1b decision): a non-empty static `kbListOverride` wins and is
 * served to every consumer — the /kb route, the /kb/select and /kb/query
 * whitelists — WITHOUT touching the network or any cache. Only when the
 * override is empty does the provider fall back to the Open WebUI
 * knowledge API (phase-2 scenario) with the 30s memory cache +
 * stale-on-failed-refresh behavior the skeleton established.
 *
 * Kept as a pure lib module so the whitelist behavior is unit-testable
 * without importing index.js (test/index.test.js stays lib-only).
 */

/**
 * Defensively normalize a `kbListOverride` config value into
 * `[{id, name, description?}]`:
 *  - drop malformed entries (non-object / missing-or-empty id or name);
 *  - dedupe by id (first wins);
 *  - strip an empty `description` so the wire shape stays `description?`.
 *
 * (schemastery 3.18.1 has no `.optional()` on fields, so the schema
 * declares `description` with `.default("")` and this is where the
 * optionality is enforced.)
 *
 * @param {Array<{id?: unknown, name?: unknown, description?: unknown}> | null | undefined} list
 * @returns {Array<{id: string, name: string, description?: string}>}
 */
export function normalizeKbListOverride(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  const seen = new Set();
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const id = typeof entry.id === "string" ? entry.id : "";
    const name = typeof entry.name === "string" ? entry.name : "";
    if (id === "" || name === "") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const item = { id, name };
    const description = typeof entry.description === "string" ? entry.description : "";
    if (description !== "") item.description = description;
    out.push(item);
  }
  return out;
}

/**
 * Build a KB list provider.
 *
 * @param {object} options
 * @param {Array<{id: string, name: string, description?: string}>} options.overrideList
 *   NORMALIZED override list (run `normalizeKbListOverride` first)
 * @param {() => Promise<Array<{id: string, name: string, description?: string}>>} options.fetchList
 *   the OWUI knowledge-API fetch (credentials resolved per call by the
 *   caller); only invoked when `overrideList` is EMPTY
 * @param {number} [options.ttlMs=30000] OWUI-list cache TTL (override mode
 *   ignores the TTL — the list is static)
 * @param {object} [options.log] logger (`warn`)
 * @returns {{
 *   source: "override" | "owui",
 *   list: () => Promise<Array<{id: string, name: string, description?: string}>>,
 * }}
 */
export function makeKbListProvider({ overrideList, fetchList, ttlMs = 30000, log }) {
  const override = Array.isArray(overrideList) ? overrideList : [];
  if (override.length > 0) {
    // Static mode: same array, every time. No network, no cache branch.
    return { source: "override", list: async () => override };
  }
  // OWUI mode: 30s in-memory cache. On a failed refresh the STALE list is
  // served when one exists (chip stays usable while OWUI hiccups); the
  // failure propagates only when nothing is cached yet.
  const cache = { at: 0, data: null };
  const list = async () => {
    const now = Date.now();
    if (cache.data !== null && now - cache.at < ttlMs) return cache.data;
    try {
      const data = await fetchList();
      cache.at = now;
      cache.data = data;
      return data;
    } catch (err) {
      if (cache.data !== null) {
        log?.warn?.("kb: list refresh failed, serving cached list");
        return cache.data;
      }
      throw err;
    }
  };
  return { source: "owui", list };
}

/**
 * Build an IDENTITY-scoped KB list provider (personal knowledge bases).
 *
 * `fetchVisible()` resolves "which knowledge bases may the CURRENT identity
 * read" (the DB's `kb_visible_kbs(email)` through the pgvector backend).
 * Every failure path degrades to `fallbackList` (the static whitelist) so a
 * missing DBA function, an unreachable database, or an unresolved identity
 * can never take the chip down — the two public KBs stay usable, and the
 * next refresh after `ttlMs` tries again.
 *
 * @param {object} options
 * @param {() => Promise<Array<{id: string, name: string, description?: string}>>} options.fetchVisible
 * @param {Array<{id: string, name: string, description?: string}>} [options.fallbackList]
 * @param {number} [options.ttlMs=60000]
 * @param {{warn?: Function}} [options.log]
 * @returns {{source: "identity", list: () => Promise<Array<object>>, currentSource: () => "identity"|"fallback", clear: () => void}}
 */
export function makeIdentityKbListProvider({ fetchVisible, fallbackList = [], ttlMs = 60000, log }) {
  const fallback = Array.isArray(fallbackList) ? fallbackList : [];
  const cache = { at: 0, data: null, source: "fallback" };
  const list = async () => {
    const now = Date.now();
    if (cache.data !== null && now - cache.at < ttlMs) return cache.data;
    try {
      const data = await fetchVisible();
      if (!Array.isArray(data) || data.length === 0) throw new Error("visible list is empty");
      cache.at = now;
      cache.data = data;
      cache.source = "identity";
      return data;
    } catch (err) {
      const why = (err !== null && typeof err === "object" && (err.code || err.message)) || "error";
      if (cache.data !== null && cache.source === "identity") {
        // Keep serving the last good identity list while the DB hiccups.
        log?.warn?.(`kb: visible list refresh failed (${why}); serving the cached identity list`);
        return cache.data;
      }
      log?.warn?.(`kb: visible list unavailable (${why}); falling back to the static whitelist`);
      cache.at = now;
      cache.data = fallback;
      cache.source = "fallback";
      return fallback;
    }
  };
  return {
    source: "identity",
    list,
    currentSource: () => cache.source,
    /** 丢弃缓存（范围切换 / 身份变化后由调用方触发）。 */
    clear: () => {
      cache.at = 0;
      cache.data = null;
      cache.source = "fallback";
    },
  };
}
