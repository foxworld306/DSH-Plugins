/**
 * dsh-kb-query — cross-encoder rerank stage (M1b.5; pure + injectable fetch).
 *
 * Contract (M0 round-5 probe, probe-rerank.mjs — production-verified, first
 * attempt 200):
 *   POST {rerankUrl}                     (same gateway as /embeddings; the
 *                                          same Bearer key = KB_EMBED_API_KEY)
 *   body:  { model, query, documents: [candidate chunk texts] }
 *   resp:  { results: [{ index: 0-based int into `documents`,
 *                         relevance_score: float }] }
 *           sorted by relevance_score DESC, ALL candidates scored.
 *   Latency: ≈1.0 s for 20 docs.
 *
 * Pipeline position (plan M1b.5): candidate collection (cosine order) →
 * rerank → final selection. The PURE VECTOR ORDER IS ALWAYS THE FALLBACK:
 * every failure mode (non-200, timeout, JSON parse failure, `results`
 * missing, out-of-range index, incomplete/duplicate scoring) degrades to
 * the cosine top-k with `degraded: "rerank-unavailable"` + a short reason —
 * a broken reranker must never fail the retrieval itself.
 *
 * Secrets: the key travels ONLY in the Authorization header; the degrade
 * reasons are fixed strings (status code / short classification) and never
 * carry a key, DSN, or chunk content.
 */

/** The single degrade flag (result annotation, not an error). */
export const RERANK_DEGRADED = "rerank-unavailable";
/** Per-document defensive cap (chars) — current chunks never reach it. */
export const RERANK_DOC_MAX_CHARS = 8000;
/** Rerank request timeout (ms) via AbortController. */
export const RERANK_TIMEOUT_MS = 5000;
/** dsh-credentials reference holding the shared embedding-gateway key. */
export const RERANK_KEY_REF = "KB_EMBED_API_KEY";

function degrade(reason) {
  return { ok: false, degraded: RERANK_DEGRADED, reason };
}

/**
 * POST one rerank request and validate the full contract.
 *
 * @param {object} options
 * @param {string} options.url rerank endpoint (incl. path)
 * @param {string} options.model reranker model name
 * @param {string} options.apiKey Bearer key (may be "" — header omitted)
 * @param {string} options.query the ORIGINAL question string
 * @param {Array<{text: string}>} options.chunks candidates in cosine order
 * @param {number} [options.timeoutMs] default 5000 (AbortController)
 * @param {Function} [options.fetchImpl] injectable fetch
 * @param {AbortSignal} [options.signal] caller's cancellation signal (C6:
 *   exec.signal) — merged with the hard timeout; on caller cancel the
 *   degrade reason is `rerank cancelled by caller`
 * @returns {Promise<{ok: true, order: Array<{index: number, score: number}>} |
 *             {ok: false, degraded: "rerank-unavailable", reason: string}>}
 *   `order` is in the endpoint's ranking order (relevance DESC) and covers
 *   every candidate exactly once (validated). NEVER throws for the
 *   documented failure modes.
 */
export async function rerankChunks({ url, model, apiKey, query, chunks, timeoutMs = RERANK_TIMEOUT_MS, signal, fetchImpl = globalThis.fetch }) {
  const list = Array.isArray(chunks) ? chunks : [];
  const n = list.length;
  let res;
  try {
    const documents = list.map((c) => (typeof c?.text === "string" ? c.text.slice(0, RERANK_DOC_MAX_CHARS) : ""));
    const fetcher = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
    res = await fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(apiKey !== undefined && apiKey !== null && apiKey !== "" ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, query, documents }),
      // C6: merge the caller's cancellation signal with the hard timeout.
      signal: AbortSignal.any([
        AbortSignal.timeout(typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : RERANK_TIMEOUT_MS),
        ...(signal && typeof signal.aborted === "boolean" && typeof signal.addEventListener === "function" ? [signal] : []),
      ]),
    });
  } catch (err) {
    // Caller cancel vs timeout (AbortSignal) vs network failure — all degrade.
    const cancelled = signal !== undefined && signal.aborted === true;
    const timedOut = !cancelled && err !== null && typeof err === "object" && (err.name === "TimeoutError" || err.name === "AbortError");
    return degrade(cancelled ? "rerank cancelled by caller" : timedOut ? "rerank timed out" : "rerank endpoint unreachable");
  }
  if (!res?.ok) {
    try {
      await res.text();
    } catch {
      /* body not needed */
    }
    const status = typeof res?.status === "number" ? res.status : 0;
    return degrade(`rerank endpoint responded ${status}`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return degrade("rerank response is not valid JSON");
  }
  const results = data !== null && typeof data === "object" ? data.results : undefined;
  if (!Array.isArray(results)) return degrade("rerank response has no results array");
  if (results.length !== n) return degrade("rerank scored an incomplete candidate set");
  const seen = new Set();
  const order = [];
  for (const item of results) {
    const index = item !== null && typeof item === "object" ? item.index : undefined;
    const score = item !== null && typeof item === "object" ? item.relevance_score : undefined;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= n || seen.has(index)) {
      return degrade("rerank returned an out-of-range or duplicate index");
    }
    if (typeof score !== "number" || !Number.isFinite(score)) {
      return degrade("rerank returned a non-finite relevance_score");
    }
    seen.add(index);
    order.push({ index, score });
  }
  return { ok: true, order };
}

/**
 * Final-selection stage: cosine-ordered candidates → rerank (when a rerank
 * config is present and there is at least one candidate) → cap at
 * `min(k, topK)` (topK clamped 1..20).
 *
 * On rerank success the candidates are re-ordered by the endpoint's
 * ranking and each surviving chunk's `score` is replaced by its
 * relevance_score (downstream shaping still applies the 0..1 honesty
 * filter). On degrade the cosine order and the original scores are kept
 * and the result carries `degraded` + `reason`.
 *
 * @param {object} options
 * @param {Array<{text: string, source?: string, score?: number}>} options.candidates cosine order
 * @param {string} options.query the original question
 * @param {number} options.k the per-call chunk cap (original k semantics)
 * @param {number} options.topK topKReranker (clamped 1..20)
 * @param {{url: string, model: string, apiKey: string, timeoutMs?: number, fetchImpl?: Function} | null} [options.rerank]
 *   rerank trigger config; `null`/absent = pure vector top-k (no fetch).
 * @param {{warn?: (m: string) => void, info?: (m: string) => void}} [options.log]
 * @param {AbortSignal} [options.signal] caller's cancellation signal, forwarded to the rerank leg
 * @returns {Promise<{results: Array<object>, degraded?: "rerank-unavailable", reason?: string}>}
 */
export async function selectFinal({ candidates, query, k, topK, rerank, log, signal }) {
  const pool = Array.isArray(candidates) ? candidates : [];
  const top = Number.isInteger(topK) && topK > 0 ? Math.min(topK, 20) : 5;
  const kCap = Number.isInteger(k) && k > 0 ? k : top;
  const finalCap = Math.max(1, Math.min(kCap, top));

  let ordered = pool;
  let degraded;
  let reason;
  if (rerank !== null && rerank !== undefined && pool.length > 0) {
    const started = Date.now();
    const out = await rerankChunks({
      url: rerank.url,
      model: rerank.model,
      apiKey: rerank.apiKey,
      query,
      chunks: pool,
      timeoutMs: rerank.timeoutMs,
      signal,
      fetchImpl: rerank.fetchImpl,
    });
    if (out.ok) {
      // Attach each candidate's relevance score, then rank by relevance_score
      // DESC for the final selection. The contract already returns results
      // sorted DESC, and V8's sort is stable — so this re-sort is a cheap
      // safety net (ties keep the endpoint's order) and makes "final
      // selection = top-k by relevance" true even if a gateway drifts.
      ordered = out.order
        .map((o) => ({ ...pool[o.index], score: o.score }))
        .sort((a, b) => b.score - a.score);
    } else {
      degraded = out.degraded;
      reason = out.reason;
      log?.warn?.(`kb: rerank degraded after ${Date.now() - started}ms (${out.reason}) — serving the cosine order`);
    }
  }

  const results = ordered.slice(0, finalCap);
  const outObj = { results };
  if (degraded !== undefined) {
    outObj.degraded = degraded;
    outObj.reason = reason;
  }
  return outObj;
}
