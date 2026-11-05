/**
 * dsh-kb-query — pure shaping/truncation for the KB list and retrieval
 * results. No host imports: everything takes plain values and returns plain
 * values, so the unit tests exercise the whole truncation/budget matrix
 * without a network or a host context.
 */

/**
 * Defensively shape a parsed Open WebUI knowledge-list body into
 * `[{id, name, description?}]`.
 * Accepts a bare array or an object wrapper ({items|data|knowledge|list});
 * items without a usable id are skipped, duplicates collapse to the first
 * occurrence, and a missing name falls back to the id (the chip needs a
 * displayable label; the M0 probe confirms the real field names).
 * @param {unknown} data parsed response body
 * @returns {Array<{id: string, name: string, description?: string}>}
 * @throws {Error} when the body matches none of the accepted shapes
 */
export function shapeKbList(data) {
  let arr;
  if (Array.isArray(data)) {
    arr = data;
  } else if (data !== null && typeof data === "object") {
    for (const key of ["items", "data", "knowledge", "list"]) {
      if (Array.isArray(data[key])) {
        arr = data[key];
        break;
      }
    }
  }
  if (arr === undefined) {
    throw new Error("knowledge list: unexpected response shape");
  }
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (item === null || typeof item !== "object") continue;
    const id =
      typeof item.id === "string" && item.id !== ""
        ? item.id
        : typeof item.uuid === "string" && item.uuid !== ""
          ? item.uuid
          : undefined;
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const entry = {
      id,
      name: typeof item.name === "string" && item.name !== "" ? item.name : id,
    };
    if (typeof item.description === "string" && item.description !== "") {
      entry.description = item.description;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Shape canonical chunks into the bounded tool/result payload:
 *  - at most `k` chunks, input order;
 *  - each text cut to `maxChunkChars`;
 *  - the summed text length capped at `budget` — the tail is cut or dropped.
 *
 * `truncated` is true whenever the caller sees less than the full,
 * untruncated retrieval: the k cap, a per-chunk cut, a budget cut, or an
 * input chunk that carried no usable text.
 *
 * Score honesty: a `score` survives only when it is a finite number inside
 * 0..1 (a plausible similarity). Cosine distances (which can reach 2),
 * negative or out-of-scale values are OMITTED rather than converted — the
 * plugin never fabricates a similarity it did not receive.
 * @param {unknown} raw canonical chunks from a backend: {text, source?, score?}
 * @param {{k?: number, maxChunkChars?: number, budget?: number}} limits
 * @returns {{results: Array<{text: string, source?: string, score?: number}>, truncated: boolean}}
 */
export function shapeResults(raw, limits) {
  const k = limits?.k !== undefined && Number.isFinite(limits.k) ? Math.max(1, Math.floor(limits.k)) : 8;
  const maxChunkChars =
    limits?.maxChunkChars !== undefined && Number.isFinite(limits.maxChunkChars)
      ? Math.max(0, Math.floor(limits.maxChunkChars))
      : 1200;
  const budget =
    limits?.budget !== undefined && Number.isFinite(limits.budget)
      ? Math.max(0, Math.floor(limits.budget))
      : 6000;
  const items = Array.isArray(raw) ? raw : [];
  const results = [];
  let truncated = false;
  let used = 0;
  const expected = Math.min(k, items.length);
  for (let i = 0; i < items.length; i++) {
    if (i >= k) {
      truncated = true;
      break;
    }
    const chunk = items[i];
    const text0 =
      chunk !== null && typeof chunk === "object"
        ? typeof chunk.text === "string"
          ? chunk.text
          : typeof chunk.content === "string"
            ? chunk.content
            : ""
        : "";
    if (text0 === "") {
      truncated = true;
      continue;
    }
    let text = text0;
    if (text.length > maxChunkChars) {
      text = text.slice(0, maxChunkChars);
      truncated = true;
    }
    if (used + text.length > budget) {
      truncated = true;
      const room = budget - used;
      if (room <= 0) break;
      text = text.slice(0, room);
    }
    const item = { text };
    if (chunk !== null && typeof chunk === "object" && typeof chunk.source === "string" && chunk.source !== "") {
      item.source = chunk.source;
    }
    const score =
      chunk !== null && typeof chunk === "object" &&
      typeof chunk.score === "number" && Number.isFinite(chunk.score) &&
      chunk.score >= 0 && chunk.score <= 1
        ? chunk.score
        : undefined;
    if (score !== undefined) item.score = score;
    results.push(item);
    used += text.length;
  }
  if (results.length < expected) truncated = true;
  return { results, truncated };
}

/**
 * Shape pgvector search rows into canonical chunks `{text, source?,
 * score?}` (M1b). The rows come from lib/pgvector.js:
 * `{id, collectionName, text, vmetadata, dist}`.
 *
 * Source mapping (probe-faithful coalesce — the real vmetadata field
 * names measured in M0 round 3, m0/probe-pgvector-e2e.mjs ② section):
 *   title ?? name ?? source ?? file <first 8 chars of file_id>,
 *   then ` · p.<page>` when `page` (or `page_label`) is present.
 * The `??` chain is the JavaScript nullish operator on purpose (an empty
 * string is NOT skipped — identical to the probe). When nothing survives
 * the `filter(Boolean)` the `source` key is OMITTED entirely.
 *
 * Score honesty (same policy as `shapeResults`): the row carries a cosine
 * DISTANCE (`<=>`), so `score = 1 - dist` is kept ONLY when the result is
 * a finite number inside 0..1 — an out-of-range distance is omitted,
 * never converted or relabeled.
 *
 * `kbName` is accepted for signature symmetry with the spec; chunks do
 * not carry the KB name (the tool result's `kb` field comes from the
 * session state snapshot instead) — it is currently unused.
 *
 * The output is then fed to the EXISTING `shapeResults` (k cap / per-chunk
 * cut / budget logic — not reimplemented here).
 *
 * @param {unknown} rows pgvector rows `[{id, collectionName, text, vmetadata, dist}]`
 * @param {{kbName?: string}} [meta] reserved
 * @returns {Array<{text: string, source?: string, score?: number}>}
 */
export function shapePgvectorRows(rows, { kbName } = {}) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const text = typeof row.text === "string" ? row.text : "";
    const meta = row.vmetadata !== null && typeof row.vmetadata === "object" ? row.vmetadata : null;
    let source;
    if (meta !== null) {
      const head =
        meta.title ?? meta.name ?? meta.source ??
        (meta.file_id ? `file ${String(meta.file_id).slice(0, 8)}` : null);
      const page =
        meta.page !== undefined ? `p.${meta.page}`
        : meta.page_label !== undefined ? `p.${meta.page_label}`
        : null;
      const parts = [head, page].filter(Boolean);
      if (parts.length > 0) source = parts.join(" · ");
    }
    const chunk = { text };
    if (source !== undefined) chunk.source = source;
    if (typeof row.dist === "number" && Number.isFinite(row.dist)) {
      const score = 1 - row.dist;
      if (score >= 0 && score <= 1) chunk.score = score;
    }
    out.push(chunk);
  }
  return out;
}
