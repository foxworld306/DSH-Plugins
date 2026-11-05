/**
 * dsh-kb-query — OpenAI-compatible text-embedding client (host half).
 *
 * Pure and injectable: depends only on the injected `fetch` (default
 * `globalThis.fetch`), so it is unit-testable without a network or pg.
 *
 * M1b measured facts (M0 rounds 2–4, m0/probe-pgvector-e2e.mjs +
 * probe-dims.mjs, cross-checked in the OWUI UI):
 *  - the gateway returns 768-dim vectors; the stored rows of both v1
 *    collections are 1536-dim (the column typmod says 1532 — STALE
 *    metadata; pgvector does not validate typmod against existing data,
 *    and OWUI retrieves against the stored dimension) — vectors are
 *    ZERO-PADDED to the collection's STORED dim (probed per collection,
 *    see lib/pgvector.js) before the SQL literal (cosine distance is
 *    invariant to trailing zero padding);
 *  - `base` is the embedding base INCLUDING /v1 (e.g.
 *    https://api-gateway.suezasia.com/v1) → POST {base}/embeddings;
 *  - secrets: the API key travels ONLY in the Authorization header, never
 *    in an error message or log line.
 */

/**
 * Embedding-pipeline failure with a stable, machine-readable code.
 * Codes: `embed-not-configured` | `embed-unreachable` |
 * `embed-error:<status>` | `embed-shape`.
 */
export class EmbedError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "EmbedError";
    this.code = code;
  }
}

/** Strip trailing slashes from a base URL (defensive; keeps joins exact). */
function stripTrailingSlashes(url) {
  let out = url;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * Zero-pad a vector to the target (collection stored-row) dimension.
 * Cosine distance is invariant to the trailing zero padding, so a
 * 768-dim gateway vector can be compared against 1536-dim stored rows.
 *
 * @param {readonly number[]} vec
 * @param {number} dim target dimension (positive integer, e.g. 1536)
 * @returns {number[]} the padded vector (the INPUT array when already
 *   `dim`-long — no copy)
 * @throws {EmbedError} `embed-shape` when `vec` is LONGER than `dim` —
 *   that is a stored-dim detection or embedding-model mismatch and must
 *   never be shipped into SQL (pgvector would reject it anyway).
 */
export function zeroPad(vec, dim) {
  if (
    !Array.isArray(vec) ||
    typeof dim !== "number" ||
    !Number.isInteger(dim) ||
    dim <= 0
  ) {
    throw new EmbedError("embed-shape", "zeroPad needs a number[] and a positive integer dim");
  }
  if (vec.length > dim) {
    throw new EmbedError(
      "embed-shape",
      `embedding dim ${vec.length} exceeds the collection's stored dim ${dim} — check the stored-dim probe / embeddingDim config`
    );
  }
  if (vec.length === dim) return vec;
  const out = new Array(dim);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i];
  for (let i = vec.length; i < dim; i++) out[i] = 0;
  return out;
}

/**
 * Render a vector as the pgvector 0.8.x INPUT literal.
 *
 * pgvector's `vector_in` / `halfvec_in` parse the JSON-array form
 * `[a,b,c]` — the PostgreSQL array form `'{a,b,c}'` is REJECTED with
 * `22P02: "Vector contents must start with '['"` (measured in production
 * against pgvector 0.8.2 during M0 round 3; the e2e probe was fixed to
 * the bracket form accordingly). The same bracket form is used for the
 * `::halfvec` cast branch.
 *
 * @param {readonly number[]} vec
 * @returns {string} e.g. `[0.1,2,0]`
 * @throws {EmbedError} `embed-shape` on an empty array or a non-finite
 *   element (NaN/Infinity must never reach SQL).
 */
export function toVectorLiteral(vec) {
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new EmbedError("embed-shape", "toVectorLiteral needs a non-empty number[]");
  }
  let out = "[";
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new EmbedError("embed-shape", "toVectorLiteral: non-finite element");
    }
    if (i > 0) out += ",";
    out += String(v);
  }
  return out + "]";
}

/**
 * Embed one text via an OpenAI-compatible `POST {base}/embeddings`
 * endpoint (`{ model, input }` body, `Bearer` auth when a key is present).
 *
 * @param {object} options
 * @param {string} options.base embedding base INCLUDING /v1 ("" = unconfigured)
 * @param {string} [options.apiKey] key for the Authorization header;
 *   `""`/absent = keyless (e.g. intranet gateway) → no header is sent
 * @param {string} options.model embedding model name ("" = unconfigured)
 * @param {string} options.text the text to embed (non-empty)
 * @param {number} [options.timeoutMs=15000] hard timeout via AbortSignal.timeout
 * @param {AbortSignal} [options.signal] caller's cancellation signal (C6:
 *   exec.signal) — merged with the hard timeout; either one aborts the
 *   in-flight request
 * @param {(url: string, init?: object) => Promise<Response>} [options.fetchImpl]
 *   injectable fetch (default `globalThis.fetch`)
 * @returns {Promise<{vector: number[], dim: number}>} the RAW gateway
 *   vector (768-dim for bce-embedding-base_v1) — zero-padding is the
 *   caller's job (`zeroPad` against the column dim).
 * @throws {EmbedError} `embed-not-configured` (base/model empty) |
 *   `embed-unreachable` (network failure / timeout) |
 *   `embed-cancelled` (caller's signal aborted) |
 *   `embed-error:<status>` (HTTP error) | `embed-shape` (bad body,
 *   missing/malformed `data[0].embedding`, or empty text)
 */
export async function embedText({
  base,
  apiKey = "",
  model,
  text,
  timeoutMs = 15000,
  signal,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof base !== "string" || base === "" || typeof model !== "string" || model === "") {
    throw new EmbedError(
      "embed-not-configured",
      "embedding endpoint (embeddingUrl) or model (embeddingModel) is not configured"
    );
  }
  if (typeof text !== "string" || text === "") {
    throw new EmbedError("embed-shape", "embedText needs a non-empty text input");
  }
  const fetcher = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  const url = `${stripTrailingSlashes(base)}/embeddings`;
  // C6: merge the caller's cancellation signal (exec.signal) with the hard
  // timeout — either one aborts the in-flight request.
  const signals = [];
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signal && typeof signal.aborted === "boolean" && typeof signal.addEventListener === "function") {
    signals.push(signal);
  }
  const merged = signals.length === 1 ? signals[0] : signals.length > 1 ? AbortSignal.any(signals) : undefined;
  let res;
  try {
    res = await fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(typeof apiKey === "string" && apiKey !== "" ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, input: text }),
      ...(merged ? { signal: merged } : {}),
    });
  } catch (err) {
    if (err instanceof EmbedError) throw err;
    if (signal !== undefined && signal.aborted === true) {
      throw new EmbedError("embed-cancelled", "embedding cancelled by caller");
    }
    // Network failure / timeout. The message deliberately does NOT echo
    // err.message or the URL: neither may carry the key, and neither is
    // actionable for the caller.
    throw new EmbedError("embed-unreachable", "embedding endpoint unreachable or timed out");
  }
  if (!res.ok) {
    try {
      await res.text(); // drain (the body may carry the upstream error detail)
    } catch {
      /* body already consumed */
    }
    throw new EmbedError(`embed-error:${res.status}`, `embedding endpoint responded ${res.status}`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new EmbedError("embed-shape", "embedding response is not valid JSON");
  }
  const vector = data?.data?.[0]?.embedding;
  if (
    !Array.isArray(vector) ||
    vector.length === 0 ||
    !vector.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    throw new EmbedError("embed-shape", "embedding response has no finite data[0].embedding array");
  }
  return { vector, dim: vector.length };
}
