/**
 * dsh-kb-query — Open WebUI retrieval client (host half, pure: depends only
 * on globalThis.fetch, so the unit tests mock it).
 *
 * Endpoints (plan §2.6):
 *  - GET  {base}/api/v1/knowledge/            knowledge-base list
 *  - POST {base}/api/v1/retrieval/query/doc   pure retrieval, no LLM
 *
 * Auth: `Authorization: Bearer <key|jwt>` — the caller resolves the token
 * from dsh-credentials per operation; the token never enters a log line or
 * an error message. Response field names are parsed defensively pending the
 * M0 probe: a KB entry's name may be absent; a chunk's text sits under
 * `content` or `text`; metadata under `meta_data` or `metadata`; the source
 * under `source` | `file_name` | `filename`.
 */

import { shapeKbList } from "./normalize.js";

/** KB list endpoint (trailing slash is part of the OWUI route). */
export const KNOWLEDGE_PATH = "/api/v1/knowledge/";
/** Pure-retrieval endpoint (no LLM round trip). */
export const RETRIEVAL_PATH = "/api/v1/retrieval/query/doc";

/**
 * An OWUI-facing failure with a stable code the routes map 1:1 into
 * `{error: code}`: `owui-unreachable` (network/abort/timeout) or
 * `owui-error:<status>` (OWUI answered 4xx/5xx).
 */
export class OwuiError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "OwuiError";
    this.code = code;
  }
}

/** @param {unknown} value @returns {string | undefined} first non-empty string */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** @param {unknown} value @returns {number | undefined} first finite number */
function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Classify a failure from the OWUI request path into a stable error code.
 * Never throws; the message is built here (bounded, no token material) so a
 * raw fetch error message can never leak into a response or a log.
 * @param {unknown} err the thrown error, however malformed
 * @param {string} [phase] "list" | "retrieve" | "request" — context only
 * @returns {{code: string, message: string}}
 */
export function classifyError(err, phase = "request") {
  if (err !== null && typeof err === "object" && typeof err.code === "string" && err.code.startsWith("owui-")) {
    return { code: err.code, message: typeof err.message === "string" ? err.message : err.code };
  }
  const aborted =
    err !== null &&
    typeof err === "object" &&
    (err.name === "AbortError" || err.code === "ABORT_ERR" || err.code === "TIMEOUT");
  if (aborted) {
    return { code: "owui-unreachable", message: `openwebui ${phase} aborted or timed out` };
  }
  if (err instanceof TypeError) {
    // Node's undici reports connection failures as TypeError("fetch failed").
    return { code: "owui-unreachable", message: `openwebui ${phase} network failure` };
  }
  const detail =
    err !== null && typeof err === "object" && typeof err.message === "string"
      ? err.message.slice(0, 200)
      : String(err ?? "unknown error").slice(0, 200);
  return { code: "owui-unreachable", message: `openwebui ${phase} failed: ${detail}` };
}

/** @param {string} url @returns {string} base without trailing slashes */
function stripTrailingSlashes(url) {
  let out = url;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * @param {AbortSignal | undefined} signal caller signal (e.g. the tool's exec.signal)
 * @param {number | undefined} timeoutMs per-request deadline
 * @returns {AbortSignal | undefined} combined signal (undefined when nothing to combine)
 */
function mergeSignals(signal, timeoutMs) {
  const parts = [];
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    parts.push(AbortSignal.timeout(timeoutMs));
  }
  if (signal !== undefined) parts.push(signal);
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : AbortSignal.any(parts);
}

/**
 * @param {import("node:fetch").Response} res
 * @returns {Promise<unknown>} parsed JSON body (200-class only)
 */
async function parseJson(res) {
  try {
    return await res.json();
  } catch {
    throw new OwuiError("owui-error:200", "openwebui: malformed JSON response body");
  }
}

/**
 * One HTTP request against the Open WebUI base.
 * @param {{base: string, token: string, method: string, path: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<import("node:fetch").Response>} the 2xx response
 * @throws {OwuiError} owui-unreachable (network/abort/timeout) or owui-error:<status> (4xx/5xx)
 */
async function owuiRequest({ base, token, method, path, body, signal, timeoutMs }) {
  const merged = mergeSignals(signal, timeoutMs);
  const url = `${stripTrailingSlashes(base)}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(merged !== undefined ? { signal: merged } : {}),
    });
  } catch (err) {
    if (err instanceof OwuiError) throw err;
    const c = classifyError(err, "request");
    throw new OwuiError(c.code, c.message);
  }
  if (!res.ok) {
    // Drain and discard the error body — its text must never leak into a
    // log line or an exception message.
    try {
      await res.text();
    } catch {
      // body already closed — nothing to drain
    }
    throw new OwuiError(`owui-error:${res.status}`, `openwebui responded ${res.status}`);
  }
  return res;
}

/**
 * Defensively normalize one Open WebUI retrieval response body into
 * canonical chunks `[{text, source?, score?}]`.
 * Accepts a bare array or an object wrapper ({results|documents|chunks});
 * text under `content`|`text`, metadata under `meta_data`|`metadata`,
 * source under `source`|`file_name`|`filename` (metadata first, then the
 * chunk top level). The score candidate set is deliberately wide
 * (score|_score|similarity|distance): the RAW value is carried through and
 * lib/normalize.js applies the 0..1 honesty filter, so a cosine distance is
 * never mislabeled as a similarity. Chunks without usable text are dropped.
 * @param {unknown} data parsed response body
 * @returns {Array<{text: string, source?: string, score?: number}>}
 */
export function shapeChunks(data) {
  let arr;
  if (Array.isArray(data)) {
    arr = data;
  } else if (data !== null && typeof data === "object") {
    for (const key of ["results", "documents", "chunks"]) {
      if (Array.isArray(data[key])) {
        arr = data[key];
        break;
      }
    }
  }
  if (arr === undefined) return [];
  const out = [];
  for (const item of arr) {
    if (item === null || typeof item !== "object") continue;
    const text = firstString(item.content, item.text);
    if (text === undefined) continue;
    const meta =
      item.meta_data !== null && typeof item.meta_data === "object"
        ? item.meta_data
        : item.metadata !== null && typeof item.metadata === "object"
          ? item.metadata
          : null;
    const entry = { text };
    const source = firstString(
      meta?.source,
      meta?.file_name,
      meta?.filename,
      item.source,
      item.file_name,
      item.filename,
      item.doc_name
    );
    if (source !== undefined) entry.source = source;
    const score = firstNumber(item.score, item._score, meta?._score, item.similarity, item.distance);
    if (score !== undefined) entry.score = score;
    out.push(entry);
  }
  return out;
}

/**
 * List the Open WebUI knowledge bases.
 * @param {{base: string, token: string, signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<Array<{id: string, name: string, description?: string}>>}
 * @throws {OwuiError}
 */
export async function listKnowledge({ base, token, signal, timeoutMs }) {
  const res = await owuiRequest({ base, token, method: "GET", path: KNOWLEDGE_PATH, signal, timeoutMs });
  const data = await parseJson(res);
  try {
    return shapeKbList(data);
  } catch {
    throw new OwuiError("owui-error:200", "openwebui: unexpected knowledge list shape");
  }
}

/**
 * Pure retrieval (no LLM) against one knowledge base (collection_name is
 * the KB's UUID in OWUI).
 * @param {{base: string, token: string, collectionName: string, query: string, k: number, signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<Array<{text: string, source?: string, score?: number}>>}
 * @throws {OwuiError}
 */
export async function retrieve({ base, token, collectionName, query, k, signal, timeoutMs }) {
  const res = await owuiRequest({
    base,
    token,
    method: "POST",
    path: RETRIEVAL_PATH,
    body: { collection_name: collectionName, query, k },
    signal,
    timeoutMs,
  });
  const data = await parseJson(res);
  return shapeChunks(data);
}
