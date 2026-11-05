/**
 * dsh-kb-query — settings-page runtime-override logic (pure module; the
 * host route handlers in index.js stay thin and unit-testable here).
 *
 * Runtime overrides (changed from the settings page) are IN-MEMORY only:
 * a DSH restart clears them and the profile config is the baseline again.
 * Only three keys are overridable — the KB whitelist is deliberately NOT
 * one of them (it is the security boundary: config `kbListOverride` stays
 * the single source of truth for /kb, /kb/select, /kb/query, and the
 * pgvector SQL guard).
 *
 * Secrets never flow through this module: a settings body carries at most
 * {backend, rerankEnabled, k, reset} — no URLs, no keys, no DSN.
 */

/** Backends the settings page may switch between. */
export const SETTINGS_BACKENDS = Object.freeze(["pgvector", "owui"]);

/** Keys a settings body may set (plus the `reset` verb). */
export const SETTINGS_MUTABLE_KEYS = Object.freeze(["backend", "rerankEnabled", "k"]);

/** Upper bound for a runtime k (topKReranker is clamped 1..20 anyway). */
export const SETTINGS_K_MAX = 20;

/**
 * Strictly validate one POST {routePrefix}/settings body.
 * @param {unknown} body
 * @returns {{ok: true} | {ok: false, error: "bad-request"}}
 */
export function validateSettingsBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad-request" };
  for (const key of Object.keys(body)) {
    if (key !== "reset" && !SETTINGS_MUTABLE_KEYS.includes(key)) return { ok: false, error: "bad-request" };
  }
  const { backend, rerankEnabled, k, reset } = body;
  if (backend !== undefined && !SETTINGS_BACKENDS.includes(backend)) return { ok: false, error: "bad-request" };
  if (rerankEnabled !== undefined && typeof rerankEnabled !== "boolean") return { ok: false, error: "bad-request" };
  if (k !== undefined && (!Number.isInteger(k) || k < 1 || k > SETTINGS_K_MAX)) return { ok: false, error: "bad-request" };
  if (reset !== undefined && typeof reset !== "boolean") return { ok: false, error: "bad-request" };
  return { ok: true };
}

/**
 * Apply a validated body to a mutable overrides object (in-place).
 * @param {object} overrides the target (mutated)
 * @param {object} body a body that passed validateSettingsBody
 * @returns {object} the overrides object (for the caller)
 */
export function applySettingsBody(overrides, body) {
  if (body.reset === true) {
    for (const key of Object.keys(overrides)) delete overrides[key];
    return overrides;
  }
  if (body.backend !== undefined) overrides.backend = body.backend;
  if (body.rerankEnabled !== undefined) overrides.rerankEnabled = body.rerankEnabled;
  if (body.k !== undefined) overrides.k = body.k;
  return overrides;
}
