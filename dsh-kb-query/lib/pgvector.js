/**
 * dsh-kb-query — pgvector direct backend (M1b).
 *
 * Retriever that bypasses Open WebUI and reads the OWUI-owned
 * `document_chunk` table directly:
 *   1. embed the query (lib/embed.js, OpenAI-compatible gateway);
 *   2. zero-pad the gateway vector to the collection's STORED ROW dim
 *      (sample-row probe; cosine-invariant) — the column typmod is STALE
 *      metadata in the production DB (M0 rounds 3/4: stored rows 1536 vs
 *      typmod 1532; pgvector does not validate typmod against existing
 *      data, and OWUI itself retrieves against the stored dim — a 1532
 *      query vector against 1536 rows fails with 22000 "different vector
 *      dimensions 1536 and 1532");
 *   3. one parameterized top-k SQL — the SAME shape as
 *      m0/probe-pgvector-e2e.mjs (production-verified):
 *        SELECT id, collection_name, text, vmetadata,
 *               (vector <=> $1::vector) AS dist
 *          FROM <table>
 *         WHERE collection_name = $2
 *         ORDER BY vector <=> $1::vector
 *         LIMIT $3
 *      with parameters `[vectorLiteral, kbId, k]` and
 *      `SET default_transaction_read_only = on` per pool client;
 *   4. map rows to `{id, collectionName, text, vmetadata, dist}`.
 *
 * Stored-dim probe (read-only, ONCE per collection, cached in-instance):
 *        SELECT length(vector::text) - length(replace(vector::text, ',', '')) + 1 AS dim
 *          FROM <table>
 *         WHERE collection_name = $1
 *         LIMIT 1
 *   (comma count = dim - 1; sample-row method; 1536 for both v1
 *   collections). Zero-pad target: `embeddingDim > 0` (explicit user fix)
 *   wins; else the sample-row probe; else (empty collection — no sample
 *   row) the catalog typmod dim, which is HARMLESS because a top-k over an
 *   empty collection never evaluates `<=>` (the fallback is NOT cached, so
 *   a sample row appearing later is picked up next call). Recovery: if the
 *   top-k query fails with a dimension mismatch (SQLSTATE 22000, or a
 *   message matching /different vector dimensions/i — a reindex changed
 *   the stored dim while the cache was warm), the cache entry is
 *   invalidated, the dim is re-probed once, and the retrieval retried
 *   ONCE; a persistent mismatch answers `pg-dim-mismatch`.
 *
 * Trust layers (defense in depth — the app-level whitelist is the FIRST,
 * the DB role the second):
 *  - `search` refuses any `kbId` outside the allowed whitelist with
 *    `kb-not-whitelisted` BEFORE any connection or outbound request;
 *  - the DB side runs as the `kb_readonly` role (m0/kb_readonly.sql):
 *    SELECT-only grants + an RLS policy limited to the two public KBs, so
 *    even a whitelist bug cannot widen the row scope.
 *
 * Error codes (stable, machine-readable — never a raw stack):
 *  - `pgvector-no-whitelist` — construction: empty kbListOverride;
 *  - `pg-bad-config` — construction: unsafe pgTableName / bad poolFactory;
 *  - `pg-not-configured` — pool creation: the pgUrlRef DSN credential is
 *    absent (resolved per pool build, per-operation credentials doctrine);
 *  - `pg-unreachable` — connect failure after ONE DSN re-resolve + pool
 *    rebuild (credentials read a fresh value per operation), or the pg
 *    driver itself could not be loaded;
 *  - `pg-dim-mismatch` — dimension mismatch (22000) persists after the
 *    one re-probe + retry (a reindex may be in flight);
 *  - `pg-error` — any other query/probe failure (message bounded to 300
 *    chars, NEVER carrying the DSN or a password);
 *  - embed-* codes pass through unchanged (lib/embed.js).
 *
 * The `pg` driver is imported LAZILY — only inside the default poolFactory.
 * This module's top level and its unit tests never touch pg (the sandbox
 * test environment does not have pg installed; tests inject a fake pool).
 */
import { embedText, zeroPad, toVectorLiteral, EmbedError } from "./embed.js";
import { shapePgvectorRows } from "./normalize.js";

/** SQL identifier (validated before interpolation; everything else is $n). */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Vector column name + type (M0 measured fact for `document_chunk`: a
 * `vector`-typed column named `vector`; pgvector 0.8.x). Trusted constants
 * — not user input — so no per-use validation; the TABLE name, which IS
 * config input, is validated at construction.
 */
const VECTOR_COLUMN = "vector";
const VECTOR_TYPE = "vector";
/** Message cap for surfaced error text (secrets never fit in a message). */
const MESSAGE_CAP = 300;
/** SQLSTATE for a vector dimension mismatch (production-measured). */
const DIM_MISMATCH_CODE = "22000";

/** pgvector-backend failure with a stable code (see module header). */
export class PgvectorError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "PgvectorError";
    this.code = code;
  }
}

/** Cap + redact a message for surfacing (password=… → password=***). */
function bounded(message) {
  const raw = typeof message === "string" && message !== "" ? message : "unknown error";
  return raw.replace(/(password=)[^\s&]+/gi, "$1***").slice(0, MESSAGE_CAP);
}

/**
 * @param {object} options
 * @param {import("../index.js").KbConfig} options.config plugin config
 *   (kbListOverride / pgUrlRef / pgTableName / embedding* / timeoutMs)
 * @param {(ref: string) => Promise<{value: string} | undefined>} options.resolveCredential
 *   dsh-credentials adapter (per-operation read; `undefined` = absent)
 * @param {object} [options.log] structured logger (`warn`/`error`)
 * @param {() => Promise<{connect: Function, end: Function}>} [options.poolFactory]
 *   injectable pool builder (unit tests pass a fake pool); the default
 *   builds a real `pg.Pool` from the DSN credential
 * @param {(url: string, init?: object) => Promise<Response>} [options.fetchImpl]
 *   injectable fetch for the embedding step (default `globalThis.fetch`)
 * @returns {{
 *   kind: "pgvector",
 *   search: (args: {kbId: string, query: string, k?: number, allowedIds?: string[] | Set<string>, signal?: AbortSignal}) => Promise<Array<object>>,
 *   retrieve: (kbId: string, query: string, k: number, opts?: {signal?: AbortSignal}) => Promise<Array<{text: string, source?: string, score?: number}>>,
 *   close: () => Promise<void>,
 * }}
 * @throws {object} `pgvector-no-whitelist` / `pg-bad-config` at construction
 */
export function createPgvectorBackend({ config, resolveCredential, log, poolFactory, fetchImpl }) {
  // ── construction-time checks (fail LOUD here, fail SOFT at boot) ──────
  const entries = (Array.isArray(config.kbListOverride) ? config.kbListOverride : []).filter(
    (e) => e !== null && typeof e === "object" && typeof e.id === "string" && e.id !== ""
  );
  if (entries.length === 0) {
    throw Object.assign(
      new Error("the pgvector backend requires a non-empty kbListOverride whitelist (same source of truth as /kb)"),
      { code: "pgvector-no-whitelist" }
    );
  }
  const allowedIds = new Set(entries.map((e) => e.id));
  const kbNames = new Map(entries.map((e) => [e.id, typeof e.name === "string" && e.name !== "" ? e.name : e.id]));

  const table = config.pgTableName;
  if (typeof table !== "string" || !IDENT_RE.test(table)) {
    throw new PgvectorError("pg-bad-config", `pgTableName must be a safe SQL identifier (got: ${bounded(table)})`);
  }
  const configuredDim =
    typeof config.embeddingDim === "number" && Number.isInteger(config.embeddingDim) && config.embeddingDim > 0
      ? config.embeddingDim
      : 0;

  /** @type {{connect: Function, end: Function} | null} */
  let pool = null;
  /** @type {Map<string, number>} collection_name → stored row dim (probe cache) */
  const dimCache = new Map();

  /** Top-k SQL (m0-probe shape; <table> validated at construction). */
  const searchSql =
    `SELECT id, collection_name, text, vmetadata, ` +
    `(${VECTOR_COLUMN} <=> $1::${VECTOR_TYPE}) AS dist ` +
    `FROM ${table} ` +
    `WHERE collection_name = $2 ` +
    `ORDER BY ${VECTOR_COLUMN} <=> $1::${VECTOR_TYPE} ` +
    `LIMIT $3`;

  /**
   * Stored-dim probe SQL (spec 修正 5: sample-row method — comma count =
   * dim - 1). Read-only; parameterized by collection_name.
   */
  const dimProbeSql =
    `SELECT length(${VECTOR_COLUMN}::text) - length(replace(${VECTOR_COLUMN}::text, ',', '')) + 1 AS dim ` +
    `FROM ${table} ` +
    `WHERE collection_name = $1 ` +
    `LIMIT 1`;

  /**
   * Catalog typmod probe SQL (atttypmod - 4 for a vector-typed column).
   * Used ONLY as the empty-collection fallback (see header). Read-only.
   */
  const catalogDimSql =
    `SELECT a.atttypmod - 4 AS dim ` +
    `FROM pg_attribute a ` +
    `JOIN pg_class c ON c.oid = a.attrelid ` +
    `WHERE c.relname = $1 AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped`;

  /**
   * Dimension-mismatch detection: the production-measured SQLSTATE, or the
   * server message when a driver/layer drops the SQLSTATE (belt +
   * suspenders per spec 修正 5).
   * @param {unknown} err
   * @returns {boolean}
   */
  const isDimMismatch = (err) =>
    err?.code === DIM_MISMATCH_CODE ||
    /different vector dimensions/i.test(typeof err?.message === "string" ? err.message : "");

  /**
   * Resolve the FULL DSN credential NOW (per-operation doctrine; never
   * cached — a password rotation is picked up on the next pool build).
   * @returns {Promise<string>}
   * @throws {PgvectorError} `pg-not-configured` when the value is absent.
   */
  const dsn = async () => {
    const hit = await resolveCredential(config.pgUrlRef);
    const value = hit !== undefined && hit !== null ? hit.value : undefined;
    if (typeof value !== "string" || value === "") {
      throw new PgvectorError(
        "pg-not-configured",
        `pg DSN credential is not configured (credentials reference: ${config.pgUrlRef})`
      );
    }
    return value;
  };

  /**
   * DEFAULT pool factory — the ONLY place the pg driver is imported
   * (lazy, so module load and unit tests work without pg installed).
   * The DSN is resolved BEFORE the pg import so a missing credential
   * surfaces as `pg-not-configured` even in pg-less environments.
   */
  async function defaultPoolFactory() {
    const connectionString = await dsn();
    let Pool;
    try {
      ({ Pool } = await import("pg"));
    } catch (err) {
      // A missing pg driver cannot reach the backend at all. The import
      // error message never contains the DSN (the DSN is a constructor
      // argument, not part of the specifier).
      throw new PgvectorError("pg-unreachable", `the pg driver could not be loaded: ${bounded(err?.message)}`);
    }
    return new Pool({
      connectionString,
      max: 2, // chip previews + tool calls are sequential in practice
      statement_timeout: config.timeoutMs, // hard stop for a runaway query
    });
  }

  const buildPool = async () => {
    const factory = typeof poolFactory === "function" ? poolFactory : defaultPoolFactory;
    const next = await factory();
    if (next === null || typeof next.connect !== "function" || typeof next.end !== "function") {
      throw new PgvectorError("pg-bad-config", "poolFactory must return a pg-like pool (connect/end)");
    }
    return next;
  };

  const getPool = async () => {
    if (pool !== null) return pool;
    pool = await buildPool();
    return pool;
  };

  const destroyPool = async () => {
    const current = pool;
    pool = null;
    if (current !== null) {
      try {
        await current.end();
      } catch {
        /* already gone */
      }
    }
  };

  /**
   * Connect a client with ONE recovery: on a connect failure, re-resolve
   * the DSN (fresh credentials value) and rebuild the pool, then retry.
   * @returns {Promise<{query: Function, release: Function}>}
   * @throws {PgvectorError} `pg-unreachable` after the retry also fails
   */
  async function acquireClient() {
    for (let attempt = 0; ; attempt++) {
      const p = await getPool();
      try {
        return await p.connect();
      } catch (err) {
        if (err instanceof PgvectorError || err instanceof EmbedError) throw err;
        if (attempt >= 1) {
          throw new PgvectorError("pg-unreachable", bounded(err?.message));
        }
        log?.warn?.("kb: pg connect failed; re-resolving the DSN and rebuilding the pool once");
        await destroyPool(); // getPool() rebuilds → default factory re-resolves the DSN
      }
    }
  }

  /**
   * Probe ONE stored row of a collection for its physical vector dim
   * (spec 修正 3/5: the stored-row dimension is the canon — OWUI retrieves
   * against it — while the column typmod is stale metadata).
   * @param {{query: Function}} client a checked-out pool client
   * @param {string} collectionName the KB UUID
   * @returns {Promise<number | null>} the stored dim (e.g. 1536), or null
   *   when no sample row fits (empty collection / unexpected shape)
   */
  async function probeStoredDim(client, collectionName) {
    const { rows } = await client.query(dimProbeSql, [collectionName]);
    const row = (rows ?? [])[0];
    const dim = row !== undefined && row !== null ? Number(row.dim) : NaN;
    if (!Number.isInteger(dim) || dim <= 0) return null;
    return dim;
  }

  /**
   * Catalog typmod dim (atttypmod - 4) of the vector column — the EMPTY
   * COLLECTION FALLBACK only (harmless: a top-k over an empty collection
   * never evaluates `<=>`).
   * @param {{query: Function}} client
   * @returns {Promise<number | null>}
   */
  async function probeCatalogDim(client) {
    const { rows } = await client.query(catalogDimSql, [table, VECTOR_COLUMN]);
    const row = (rows ?? [])[0];
    const dim = row !== undefined && row !== null ? Number(row.dim) : NaN;
    if (!Number.isInteger(dim) || dim <= 0) return null; // unqualified column (atttypmod -1)
    return dim;
  }

  /**
   * The zero-pad target for a collection (spec 修正 5 rules):
   *  1. `embeddingDim > 0` (explicit user fix) — wins, no probe;
   *  2. else the probed STORED dim (sample row), cached per collection
   *     (the probe runs ONCE per collection and is then cached);
   *  3. else (empty collection) the catalog typmod dim — NOT cached, so a
   *     sample row appearing later is picked up by the next call (or by
   *     the 22000 re-probe path if the data landed with a different dim).
   * @param {{query: Function}} client
   * @param {string} collectionName
   * @returns {Promise<number>}
   * @throws {PgvectorError} `pg-error` when no probe yields a dim
   */
  async function getStoredDim(client, collectionName) {
    if (configuredDim > 0) return configuredDim;
    if (dimCache.has(collectionName)) return dimCache.get(collectionName);
    const sample = await probeStoredDim(client, collectionName);
    if (sample !== null) {
      dimCache.set(collectionName, sample);
      return sample;
    }
    const catalog = await probeCatalogDim(client);
    if (catalog !== null) return catalog;
    throw new PgvectorError(
      "pg-error",
      `cannot determine the vector dim of collection ${collectionName} (no sample row, no usable column typmod)`
    );
  }

  /**
   * Resolve the embedding API key per operation ("" = keyless gateway →
   * no Authorization header). Never logged.
   * @returns {Promise<string>}
   */
  async function resolveEmbedKey() {
    if (config.embeddingKeyRef === "") return "";
    const hit = await resolveCredential(config.embeddingKeyRef);
    const value = hit !== undefined && hit !== null ? hit.value : undefined;
    return typeof value === "string" ? value : "";
  }

  /**
   * One top-k attempt: stored dim (config override or cached probe) →
   * zero-pad → bracket literal → parameterized query. With `allowDimRetry`,
   * a dimension mismatch (SQLSTATE 22000 — a reindex changed the stored
   * dim while the cache was warm) invalidates the cache entry, re-probes
   * the stored dim, and retries the query EXACTLY once.
   * @param {{query: Function}} client
   * @param {string} kbId collection_name (KB UUID)
   * @param {number} limit
   * @param {number[]} vector the raw gateway vector
   * @param {boolean} allowDimRetry
   * @returns {Promise<{rows: Array<object>}>} the pg result
   */
  async function runTopK(client, kbId, limit, vector, allowDimRetry) {
    const dim = await getStoredDim(client, kbId);
    const literal = toVectorLiteral(zeroPad(vector, dim)); // pgvector 0.8.x: [a,b,c]
    try {
      // $1 = vector literal (bracket form, zero-padded to THIS collection's
      // stored dim), $2 = collection_name (kbId), $3 = k. Cosine distance
      // ascending.
      return await client.query(searchSql, [literal, kbId, limit]);
    } catch (err) {
      if (!isDimMismatch(err) || !allowDimRetry) throw err;
      log?.warn?.(
        "kb: dimension mismatch on the top-k query (SQLSTATE 22000) — re-probing the stored dim and retrying once"
      );
      dimCache.delete(kbId);
      const dim2 = await getStoredDim(client, kbId);
      const literal2 = toVectorLiteral(zeroPad(vector, dim2));
      return await client.query(searchSql, [literal2, kbId, limit]);
    }
  }

  /**
   * One retrieval. `allowedIds` is the caller's whitelist (a Set or array
   * of KB UUIDs); `retrieve` binds the construction-time whitelist.
   *
   * Ordering: whitelist → C6 abort → embed (fail fast, no pool) → connect
   * (+ read-only fence) → stored dim (cached per collection) → top-k with
   * the 22000 re-probe/retry fallback. The pg query itself is not
   * signal-cancellable (pg 8.x has no query-level AbortSignal); the embed
   * step and `statement_timeout` are bounded.
   *
   * @param {object} args
   * @param {string} args.kbId KB UUID (the OWUI collection_name)
   * @param {string} args.query the question text
   * @param {number} [args.k] top-k (clamped 1..50)
   * @param {string[] | Set<string>} [args.allowedIds] whitelist (defaults
   *   to the construction-time whitelist)
   * @param {AbortSignal} [args.signal] C6: already-aborted → reject now;
   *   also forwarded to the embedding step (merged with its hard timeout)
   * @returns {Promise<Array<{id: string, collectionName: string, text: string, vmetadata: object | null, dist: number}>>}
   * @throws {object} `kb-not-whitelisted` | `pg-*` | `embed-*` (see header)
   */
  async function search({ kbId, query, k, allowedIds: allowed, signal }) {
    if (signal !== undefined) signal.throwIfAborted?.();
    const whitelist =
      allowed instanceof Set ? allowed : new Set(Array.isArray(allowed) ? allowed : [...allowedIds]);
    if (typeof kbId !== "string" || !whitelist.has(kbId)) {
      throw new PgvectorError("kb-not-whitelisted", "kbId is not in the allowed knowledge bases");
    }
    const limit = Math.max(1, Math.min(50, Math.floor(k ?? config.k ?? 8)));

    // 1) embed BEFORE touching the pool (no PG cost for bad input).
    const { vector } = await embedText({
      base: config.embeddingUrl,
      apiKey: await resolveEmbedKey(),
      model: config.embeddingModel,
      text: query,
      timeoutMs: config.timeoutMs,
      signal,
      fetchImpl,
    });

    // 2) connect (+ read-only fence) → 3) stored dim (cached) → 4) top-k.
    const client = await acquireClient();
    try {
      await client.query("SET default_transaction_read_only = on");
      const result = await runTopK(client, kbId, limit, vector, true);
      return (result?.rows ?? []).map((row) => ({
        id: row?.id,
        collectionName: row?.collection_name,
        text: row?.text,
        vmetadata: row?.vmetadata ?? null,
        dist: row?.dist,
      }));
    } catch (err) {
      if (err instanceof PgvectorError || err instanceof EmbedError) throw err;
      if (isDimMismatch(err)) {
        // The re-probe/retry inside runTopK already happened; a second
        // mismatch means the dim is still in flux (reindex in flight).
        throw new PgvectorError(
          "pg-dim-mismatch",
          "dimension mismatch (22000) persists after the re-probe/retry — a reindex may be in flight; check the collection's stored dim"
        );
      }
      // Query/probe/SET failure. The DSN is only ever handed to the pool
      // constructor — it never reaches an error message — so the bounded
      // message cannot carry a password.
      throw new PgvectorError("pg-error", bounded(err?.message));
    } finally {
      try {
        client.release?.();
      } catch {
        /* already returned */
      }
    }
  }

  return {
    kind: "pgvector",
    /** Raw-row API (spec signature; unit tests target this). */
    search: (args) => search(args),
    /**
     * kb-tool contract: canonical chunks `{text, source?, score?}` —
     * identical shape to the owui backend's retrieve (lib/kb-tool.js is
     * backend-agnostic).
     */
    async retrieve(kbId, query, k, opts) {
      const rows = await search({ kbId, query, k, allowedIds, signal: opts?.signal });
      return shapePgvectorRows(rows, { kbName: kbNames.get(kbId) });
    },
    /**
     * Settings-page connectivity probe: SELECT 1 over a pool client.
     * Reuses the DSN resolve + pool-build path, so the same error codes
     * apply (pg-not-configured / pg-unreachable / pg-error).
     * @returns {Promise<{ok: true, ms: number}>}
     * @throws {PgvectorError}
     */
    async probe() {
      const started = Date.now();
      const client = await acquireClient();
      try {
        await client.query("SELECT 1");
        return { ok: true, ms: Date.now() - started };
      } catch (err) {
        if (err instanceof PgvectorError) throw err;
        throw new PgvectorError("pg-error", bounded(err?.message));
      } finally {
        try {
          client.release?.();
        } catch {
          /* already returned */
        }
      }
    },
    /** Close the pool (plugin disposal / HMR). Safe when never opened. */
    close: () => destroyPool(),
  };
}
