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
