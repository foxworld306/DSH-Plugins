/**
 * dsh-kb-query — company knowledge-base (RAG) access for dsh web agents.
 *
 * What this plugin does:
 *  - registers the `kb_search` model tool: the agent searches the session's
 *    active knowledge base and answers grounded in the returned chunks —
 *    standard RAG, results enter the turn as a tool result and NEVER touch
 *    the prompt draft (plan §2.8);
 *  - serves three same-origin routes for the composer chip (browser half,
 *    client.js), all behind the trust fence:
 *      GET  {routePrefix}        KB list → [{id, name, description?}]
 *      POST {routePrefix}/select {sessionId, kbId|null} → {ok:true}
 *      POST {routePrefix}/query  {kbId, query, k?} → {results, truncated, degraded?, reason?} (preview only; degraded present when the
 *        rerank stage fell back to the cosine order)
 *  - resolves every secret (OWUI key, PG DSN, embedding key) from
 *    dsh-credentials PER OPERATION (soft dependency, mirroring the SSO
 *    plugin's sharedSecretRef handling: an unconfigured credential
 *    degrades routes to a structured 503 — no outbound request — and the
 *    tool to a structured backend-error, never a boot failure).
 *
 * Rerank stage (M1b.5): candidate collection (cosine order, `fetchK`) →
 * cross-encoder rerank (bge-reranker-v2-m3, same gateway + key as the
 * embeddings, M0 round-5 contract) → final selection `min(k,
 * topKReranker)`. Triggered only when `rerankEnabled` AND the
 * KB_EMBED_API_KEY credential resolves AND candidates exist; ANY rerank
 * failure degrades to the pure cosine order (result annotated
 * `degraded: "rerank-unavailable"`) — retrieval itself never fails
 * because of the reranker.
 *
 * KB list / whitelist source of truth (M1b): the static `kbListOverride`
 * list serves BOTH backends — /kb, the /kb/select + /kb/query whitelists,
 * and the pgvector app-level whitelist. A non-empty override means zero
 * network; the OWUI knowledge API (30s cache) is the empty-override
 * fallback only.
 *
 * Security boundary:
 *  - every secret (OWUI base URL + key, PG DSN, embedding key) stays host-
 *    side as a config reference + dsh-credentials entry; /kb* responses and
 *    logs never carry a secret;
 *  - /kb* is NOT under the /api fence, so every handler runs the trust
 *    fence (lib/fence.js, ported from dsh-better-sidebar, behaviorally
 *    identical to the /api gateway fence) and refuses otherwise;
 *  - the trusted-header SSO gate (sibling plugin) wraps all registered
 *    handlers automatically, so it covers these routes with no extra work;
 *  - logs record sid / kbId / query LENGTH / result count / duration —
 *    never chunk content, never the key.
 *
 * Backends (M1b): `pgvector` (default — direct document_chunk read via a
 * read-only RLS-limited role; lib/pgvector.js + lib/embed.js) and `owui`
 * (Open WebUI retrieval API; still implemented and untouched — note: OWUI
 * 0.8.12's retrieval endpoint answers 400 upstream, issue #14432; usable
 * again once OWUI ≥ 0.9.5 is deployed).
 */
import z from "@deepseek-ai/schemastery";
import { isTrustedApiRequest } from "./lib/fence.js";
import { classifyError, listKnowledge, retrieve } from "./lib/owui.js";
import { shapeResults } from "./lib/normalize.js";
import { makeSessionKbState } from "./lib/state.js";
import { makeKbSearchTool } from "./lib/kb-tool.js";
import { createPgvectorBackend } from "./lib/pgvector.js";
import { normalizeKbListOverride, makeKbListProvider } from "./lib/kb-list.js";
import { RERANK_KEY_REF, RERANK_TIMEOUT_MS, rerankChunks, selectFinal } from "./lib/rerank.js";
import { embedText } from "./lib/embed.js";
import { applySettingsBody, validateSettingsBody } from "./lib/settings.js";

/** Hard dependencies: routes on webServer, the tool on tools. */
export const inject = ["webServer", "tools"];

export const Config = z.object({
  /**
   * Retrieval backend. Default `pgvector` (M1b decision): OWUI 0.8.12's
   * retrieval endpoint answers 400 (upstream issue #14432) — `owui` stays
   * available once OWUI ≥ 0.9.5 is deployed.
   */
  backend: z.union([z.const("owui"), z.const("pgvector")]).default("pgvector"),
  /** Master switch: false registers nothing. */
  enabled: z.boolean().default(true),
  /** Open WebUI base URL, e.g. https://owui.contoso.com ("" = unconfigured). */
  openwebuiUrl: z.string().default(""),
  /** dsh-credentials reference holding the OWUI API key (service key) or JWT. */
  apiKeyRef: z.string().default("OPENWEBUI_API_KEY"),
  /**
   * dsh-credentials reference holding the FULL read-only PG DSN
   * (postgres://kb_readonly:…@host:5432/powergpt) for the pgvector
   * backend; resolved per pool build (never cached).
   */
  pgUrlRef: z.string().default("OWUI_PG_READONLY_URL"),
  /** OWUI vector table name; legacy OWUI versions used `vector_search`. */
  pgTableName: z.string().default("document_chunk"),
  /**
   * OpenAI-compatible embedding base INCLUDING /v1 (pgvector backend);
   * align with OWUI RAG_EMBEDDING_*.
   */
  embeddingUrl: z.string().default(""),
  /** Embedding model name (pgvector backend). */
  embeddingModel: z.string().default(""),
  /** dsh-credentials reference for the embedding key; "" = keyless (e.g. intranet). */
  embeddingKeyRef: z.string().default(""),
  /**
   * Vector dimension of the collection's STORED rows (pgvector).
   * 0 = probe it from a stored row at runtime (per collection, cached —
   * the column typmod is stale metadata: it is consulted ONLY as the
   * empty-collection fallback, harmless since an empty top-k never
   * compares vectors); when > 0 the probe is skipped and exactly this
   * dim is used.
   */
  embeddingDim: z.number().step(1).min(0).default(0),
  /** Per-call chunk cap (1..50). */
  k: z.number().step(1).min(1).max(50).default(8),
  /** Max characters per chunk text. */
  maxChunkChars: z.number().step(1).min(1).default(1200),
  /** Total tool-result budget (characters across all chunks). */
  contextBudget: z.number().step(1).min(1).default(6000),
  /** Non-loopback Host authorities the fence accepts (see lib/fence.js). */
  trustedHosts: z.array(z.string()).default([]),
  /**
   * Static KB whitelist — the SINGLE source of truth for which knowledge
   * bases exist (serves BOTH backends: the /kb list, the /kb/select +
   * /kb/query whitelists, and the pgvector app-level whitelist). A
   * non-empty list means zero network; empty = fall back to the OWUI
   * knowledge API (phase-2). schemastery 3.18.1 has no `.optional()`, so
   * `description` is `""`-defaulted and stripped at the boundary
   * (lib/kb-list.js keeps the wire shape `description?`).
   */
  kbListOverride: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().default(""),
    })
  ).default([
    {
      id: "85a173a4-af87-4a70-b91a-a3bf9e3bda59",
      name: "SUEZ Knowledge",
      description: "公司内部知识库（SUEZ Knowledge，约 1,671 chunks）",
    },
    {
      id: "71dfcd55-6f09-4c39-a698-e29eaf398b1a",
      name: "Water Treatment Documents",
      description: "水处理技术文档库（Water Treatment Documents，约 12,996 chunks）",
    },
  ]),
  /** Route prefix for the three browser routes. */
  routePrefix: z.string().default("/kb"),
  /** Per-request timeout for outbound calls (OWUI / embeddings; ms). */
  timeoutMs: z.number().step(1).min(1).default(15000),
  /**
   * Rerank stage (M1b.5): when true, cosine candidates are re-ranked by the
   * cross-encoder before the final selection. Triggered only when
   * `rerankEnabled` AND the dsh-credentials reference KB_EMBED_API_KEY
   * resolves AND there is at least one candidate. Any rerank failure
   * DEGRADES to the pure cosine top-k (the result then carries
   * `degraded: "rerank-unavailable"` + a short reason) — retrieval itself
   * never fails because of the reranker.
   */
  rerankEnabled: z.boolean().default(true),
  /** Cross-encoder rerank endpoint (same gateway as the embeddings). */
  rerankUrl: z.string().default("https://api-gateway.suezasia.com/v1/rerank"),
  /** Reranker model name. */
  rerankModel: z.string().default("bge-reranker-v2-m3"),
  /** Candidates collected (in cosine order) before rerank (10..50). */
  fetchK: z.number().step(1).min(10).max(50).default(20),
  /**
   * Final chunk cap AFTER rerank (1..20); a retrieval returns
   * `min(k, topKReranker)` chunks.
   */
  topKReranker: z.number().step(1).min(1).max(20).default(5),
});
/** @typedef {ReturnType<typeof Config["_zod"]> | {backend: "owui"|"pgvector", enabled: boolean, openwebuiUrl: string, apiKeyRef: string, pgUrlRef: string, pgTableName: string, embeddingUrl: string, embeddingModel: string, embeddingKeyRef: string, embeddingDim: number, k: number, maxChunkChars: number, contextBudget: number, trustedHosts: string[], kbListOverride: Array<{id: string, name: string, description?: string}>, routePrefix: string, timeoutMs: number, rerankEnabled: boolean, rerankUrl: string, rerankModel: string, fetchK: number, topKReranker: number}} KbConfig */

/** KB list cache TTL (OWUI is the metadata authority; UUIDs are stable). */
const KB_LIST_TTL_MS = 30_000;
/** POST body cap (64 KiB is far beyond any sane preview query). */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {KbConfig} config
 */
export function apply(ctx, config) {
  if (config.enabled === false) return; // register nothing
  const server = ctx.get("webServer");
  const tools = ctx.get("tools");
  if (server === undefined && tools === undefined) return;
  const log = ctx.logger("kb-query");

  /** Session → active KB (in-memory; the chip re-arms per render, plan R7). */
  const state = makeSessionKbState();

  /**
   * Runtime overrides (settings page; IN-MEMORY only — a DSH restart clears
   * them and the profile config is the baseline again). Whitelisted keys:
   * backend, rerankEnabled, k (lib/settings.js). The KB whitelist is NOT
   * overridable — it is the security boundary.
   */
  const overrides = Object.create(null);
  /** Effective config for one operation: profile config + overrides. */
  const eff = () => ({ ...config, ...overrides });

  /**
   * Per-operation config+credential resolution (soft dependency): resolves
   * the OWUI token NOW, never caches it (dsh-credentials doctrine). An
   * unconfigured base OR key is `owui-not-configured` — the caller must not
   * send any outbound request.
   * @returns {Promise<{error: string} | {base: string, token: string}>}
   */
  const resolveOwui = async () => {
    if (config.openwebuiUrl === "") return { error: "owui-not-configured" };
    const credentials = ctx.get("credentials");
    const hit = credentials !== undefined ? await credentials.resolve(config.apiKeyRef) : undefined;
    const token = hit !== undefined && hit !== null ? hit.value : undefined;
    if (typeof token !== "string" || token === "") return { error: "owui-not-configured" };
    return { base: config.openwebuiUrl, token };
  };

  // ── KB list: ONE source of truth for both backends (M1b) ─────────────────
  // A non-empty kbListOverride is served statically — zero network, no
  // cache branch — to every consumer (/kb, the select/query whitelists,
  // the pgvector whitelist). An EMPTY override falls back to the OWUI
  // knowledge API with the 30s cache (stale list served on a failed
  // refresh, so the chip stays usable while OWUI hiccups).
  const overrideList = normalizeKbListOverride(config.kbListOverride);
  const kbProvider = makeKbListProvider({
    overrideList,
    fetchList: async () => {
      const owui = await resolveOwui();
      if (owui.error) throw Object.assign(new Error(owui.error), { code: owui.error });
      return listKnowledge({ base: owui.base, token: owui.token, timeoutMs: config.timeoutMs });
    },
    ttlMs: KB_LIST_TTL_MS,
    log,
  });
  /**
   * @returns {Promise<Array<{id: string, name: string, description?: string}>>}
   */
  const listKbs = () => kbProvider.list();

  // ── The backend both the routes and the tool retrieve through ────────────
  // Construction is fail-SOFT: a pgvector configuration problem (empty
  // whitelist, unsafe table name) aborts construction but NOT the plugin
  // boot — retrieval answers the construction error with code passthrough
  // (routes → 503 {error: code}, tool → backend-error).
  /**
   * dsh-credentials adapter (soft dependency, per-operation read):
   * normalizes `resolve(ref)`'s `{value, source} | undefined` to
   * `{value} | undefined` (absent/empty value = undefined).
   * @param {string} ref credentials reference
   * @returns {Promise<{value: string} | undefined>}
   */
  const resolveCredential = async (ref) => {
    const credentials = ctx.get("credentials");
    if (credentials === undefined) return undefined;
    const hit = await credentials.resolve(ref);
    return hit !== undefined && hit !== null ? { value: hit.value } : undefined;
  };

  /** OWUI retrieval backend (unchanged from the skeleton). */
  const owuiBackend = {
    kind: "owui",
    /**
     * @param {string} kbId
     * @param {string} query
     * @param {number} k
     * @param {{signal?: AbortSignal}} [opts]
     * @returns {Promise<Array<{text: string, source?: string, score?: number}>>}
     */
    async retrieve(kbId, query, k, opts) {
      const owui = await resolveOwui();
      if (owui.error) {
        throw Object.assign(
          new Error("Open WebUI is not configured (openwebuiUrl or the API key reference)"),
          { code: owui.error }
        );
      }
      return retrieve({
        base: owui.base,
        token: owui.token,
        collectionName: kbId,
        query,
        k,
        timeoutMs: config.timeoutMs,
        signal: opts?.signal,
      });
    },
    /** Settings-page probe: the OWUI knowledge list (cheap, authed). */
    async probe() {
      const owui = await resolveOwui();
      if (owui.error) throw Object.assign(new Error(owui.error), { code: owui.error });
      const started = Date.now();
      await listKnowledge({ base: owui.base, token: owui.token, timeoutMs: config.timeoutMs });
      return { ok: true, ms: Date.now() - started };
    },
  };

  // Backend selection is RUNTIME-SWITCHABLE (settings page): the pgvector
  // backend is built LAZILY on first use of that backend (a backend toggle
  // must not require a restart). Construction stays fail-SOFT — a config
  // problem aborts construction but NOT the plugin boot: retrieval/probe
  // answer the construction error with code passthrough (routes → 503).
  const backendCache = { pgvector: undefined, owui: owuiBackend };
  /** @param {"pgvector"|"owui"} which @returns {{kind: string, retrieve: Function, probe?: Function, close?: Function}} */
  const getBackend = (which) => {
    if (which === "owui") return owuiBackend;
    if (backendCache.pgvector === undefined) {
      try {
        backendCache.pgvector = createPgvectorBackend({ config, resolveCredential, log });
      } catch (err) {
        const code = typeof err?.code === "string" && err.code !== "" ? err.code : "backend-not-configured";
        const message =
          typeof err?.message === "string" && err.message !== "" ? err.message : "backend construction failed";
        log.error(`kb: pgvector backend construction failed code=${code}: ${message}`);
        backendCache.pgvector = {
          kind: "pgvector",
          /** Fail-soft retrieval: every call rejects with the construction error. */
          async retrieve() {
            throw Object.assign(new Error(message), { code });
          },
          async probe() {
            throw Object.assign(new Error(message), { code });
          },
          close: () => {},
        };
      }
    }
    return backendCache.pgvector;
  };

  // ── Final selection stage (M1b.5): fetchK → rerank → min(k, topK) ──────
  // Wraps the raw backend (routes AND the tool retrieve through it):
  //  - candidates: rawBackend.retrieve(kbId, query, fetchK) — cosine order;
  //  - rerank: triggered only when `rerankEnabled` AND the KB_EMBED_API_KEY
  //    credential resolves (the shared embedding-gateway key, per-operation
  //    resolution — never cached) AND at least one candidate exists;
  //  - final: min(k, topKReranker) chunks. ANY rerank failure degrades to
  //    the cosine top-k with `degraded: "rerank-unavailable"` + a short
  //    reason — retrieval itself never fails because of the reranker.
  // Backend errors (owui-* / pg-* / embed-* / kb-*) pass through UNCHANGED.
  const finalBackend = {
    /**
     * @param {string} kbId
     * @param {string} query
     * @param {number} k per-call chunk cap (original k semantics)
     * @param {{signal?: AbortSignal}} [opts]
     * @returns {Promise<{results: Array<object>, degraded?: "rerank-unavailable", reason?: string}>}
     */
    async retrieve(kbId, query, k, opts) {
      const e = eff();
      const candidates = await getBackend(e.backend).retrieve(kbId, query, e.fetchK, opts);
      const pool = Array.isArray(candidates) ? candidates : candidates?.results ?? [];
      let rerank;
      if (e.rerankEnabled && pool.length > 0) {
        const keyHit = await resolveCredential(RERANK_KEY_REF);
        const key = keyHit !== undefined ? keyHit.value : undefined;
        if (typeof key === "string" && key !== "") {
          rerank = {
            url: e.rerankUrl,
            model: e.rerankModel,
            apiKey: key,
            timeoutMs: RERANK_TIMEOUT_MS,
            fetchImpl: globalThis.fetch,
          };
        }
      }
      return selectFinal({ candidates: pool, query, k, topK: e.topKReranker, rerank, log, signal: opts?.signal });
    },
    /** Settings-page probe for the CURRENT backend (pgvector: SELECT 1; owui: knowledge list). */
    async probe() {
      const e = eff();
      const backend = getBackend(e.backend);
      if (typeof backend.probe !== "function") {
        throw Object.assign(new Error("backend probe unavailable"), { code: "backend-not-configured" });
      }
      return backend.probe();
    },
    close: () => {
      void backendCache.pgvector?.close?.();
    },
  };

  // Dispose the pgvector pool (if built) when this plugin's fiber unloads.
  ctx.effect(
    () => () => {
      void backendCache.pgvector?.close?.();
    },
    "kb-query: dispose backend"
  );

  /**
   * Trust fence gate for one request (403 on refuse). The SSO gate, when
   * mounted, wraps these handlers too — the fence is the SECOND layer for
   * cross-site/cross-origin requests that somehow pass authentication.
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @returns {boolean} false = already answered 403
   */
  const passFence = (req, res) => {
    if (isTrustedApiRequest(req, config.trustedHosts)) return true;
    log.warn(`kb: fence refused host=${req.headers.host ?? "?"} from=${req.socket?.remoteAddress ?? "?"}`);
    sendJson(res, 403, { error: "forbidden" });
    return false;
  };

  /** @param {import("node:http").ServerResponse} res @param {number} code @param {object} body */
  const sendJson = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  /**
   * Read and JSON-parse one POST body. @param {import("node:http").IncomingMessage} req
   * @returns {Promise<object | null>} null = bad-request (oversized / non-JSON / non-object)
   */
  const readJsonBody = (req) =>
    new Promise((resolve, reject) => {
      let data = "";
      let overflow = false;
      req.on("data", (chunk) => {
        data += chunk;
        if (data.length > MAX_BODY_BYTES) {
          overflow = true;
          req.removeAllListeners("data");
          resolve(null);
          return;
        }
      });
      req.on("end", () => {
        if (overflow) return resolve(null);
        try {
          const body = JSON.parse(data);
          resolve(body !== null && typeof body === "object" && !Array.isArray(body) ? body : null);
        } catch {
          resolve(null);
        }
      });
      req.on("error", () => resolve(null));
    });

  /** @param {import("node:http").ServerResponse} res */
  const badRequest = (res) => sendJson(res, 400, { error: "bad-request" });

  /**
   * Unified 503 answer for backend failures (list/select/query phases).
   * Coded errors (owui-*, pg-*, embed-*, kb-* families) pass through their
   * code; only codeless errors (network-layer TypeError etc.) are
   * classified by classifyError.
   * @param {unknown} err @param {string} phase @param {import("node:http").ServerResponse} res
   */
  const answerBackendError = (err, phase, res) => {
    const code =
      err !== null && typeof err === "object" && typeof err.code === "string" && err.code !== ""
        ? err.code
        : classifyError(err, phase).code;
    log.warn(`kb: ${phase} failed code=${code}`);
    sendJson(res, 503, { error: code });
  };

  // ── 1) GET {routePrefix} — KB list (static override, else 30s cache) ───
  if (server !== undefined) {
    ctx.effect(
      () =>
        server.register({
          kind: "exact",
          path: config.routePrefix,
          handler: async (req, res) => {
            if (!passFence(req, res)) return;
            if (req.method !== "GET" && req.method !== "HEAD") {
              sendJson(res, 405, { error: "method-not-allowed" });
              return;
            }
            try {
              const kbs = await listKbs();
              log.info(`kb: list n=${kbs.length}`);
              sendJson(res, 200, kbs);
            } catch (err) {
              answerBackendError(err, "list", res);
            }
          },
        }),
      "kb-query: KB list route"
    );

    // ── 2) POST {routePrefix}/select — session → active KB ───────────────
    ctx.effect(
      () =>
        server.register({
          kind: "exact",
          path: `${config.routePrefix}/select`,
          handler: async (req, res) => {
            if (!passFence(req, res)) return;
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "method-not-allowed" });
              return;
            }
            const body = await readJsonBody(req);
            if (body === null) return badRequest(res);
            const { sessionId, kbId } = body;
            if (typeof sessionId !== "string" || sessionId === "") return badRequest(res);
            if (kbId === null || kbId === undefined) {
              state.clear(sessionId);
              log.info(`kb: select session=${sessionId} kbId=null`);
              return sendJson(res, 200, { ok: true });
            }
            if (typeof kbId !== "string" || kbId === "") return badRequest(res);
            // Whitelist: kbId must be a KB that listKbs() currently serves
            // (the static override, or the OWUI list when the override is empty).
            let kbs;
            try {
              kbs = await listKbs();
            } catch (err) {
              return answerBackendError(err, "list", res);
            }
            const kb = kbs.find((entry) => entry.id === kbId);
            if (kb === undefined) return sendJson(res, 400, { error: "kb-unknown" });
            state.set(sessionId, { id: kb.id, name: kb.name }, kbs.map((entry) => entry.id));
            log.info(`kb: select session=${sessionId} kbId=${kb.id}`);
            sendJson(res, 200, { ok: true });
          },
        }),
      "kb-query: select route"
    );

    // ── 3) POST {routePrefix}/query — preview retrieval (chip only) ──────
    ctx.effect(
      () =>
        server.register({
          kind: "exact",
          path: `${config.routePrefix}/query`,
          handler: async (req, res) => {
            if (!passFence(req, res)) return;
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "method-not-allowed" });
              return;
            }
            const body = await readJsonBody(req);
            if (body === null) return badRequest(res);
            const { kbId, query } = body;
            if (typeof kbId !== "string" || kbId === "") return badRequest(res);
            if (typeof query !== "string" || query.trim() === "" || query.length > 500) {
              return badRequest(res);
            }
            let k = eff().k;
            if (body.k !== undefined) {
              if (typeof body.k !== "number" || !Number.isFinite(body.k) || body.k < 1) {
                return badRequest(res);
              }
              k = Math.min(Math.floor(body.k), eff().k);
            }
            // Whitelist: only a KB that listKbs() currently serves (the
            // static override, or the OWUI list) may be queried.
            let kbs;
            try {
              kbs = await listKbs();
            } catch (err) {
              return answerBackendError(err, "list", res);
            }
            const kb = kbs.find((entry) => entry.id === kbId);
            if (kb === undefined) return sendJson(res, 400, { error: "kb-unknown" });
            const started = Date.now();
            try {
              // Both backends share the same flow: finalBackend.retrieve
              // (fetchK candidates → rerank → min(k, topKReranker)) returns
              // {results, degraded?, reason?}; shapeResults applies k /
              // truncation / budget. Backend-specific errors (owui-* / pg-*
              // / embed-*) surface via answerBackendError with code
              // passthrough; a degraded rerank is NOT an error.
              const retrieval = await finalBackend.retrieve(kbId, query.trim(), k);
              const chunks = Array.isArray(retrieval) ? retrieval : retrieval?.results ?? [];
              const shaped = shapeResults(chunks, {
                k,
                maxChunkChars: config.maxChunkChars,
                budget: config.contextBudget,
              });
              log.info(
                `kb: query kbId=${kbId} queryChars=${query.length} k=${k} results=${shaped.results.length} truncated=${shaped.truncated}${retrieval?.degraded ? " rerank=degraded" : ""} ms=${Date.now() - started}`
              );
              const response = { results: shaped.results, truncated: shaped.truncated };
              if (retrieval !== null && typeof retrieval === "object" && !Array.isArray(retrieval) && retrieval.degraded) {
                response.degraded = retrieval.degraded;
                if (typeof retrieval.reason === "string" && retrieval.reason !== "") response.reason = retrieval.reason;
              }
              sendJson(res, 200, response);
            } catch (err) {
              answerBackendError(err, "retrieve", res);
            }
          },
        }),
      "kb-query: preview query route"
    );

    // ── 4) {routePrefix}/settings — settings page (ONE route) ─────────────
    // The host webserver keys exact routes by PATH ALONE (no method
    // dimension), so GET and POST dispatch inside a single handler.
    //   GET/HEAD: state for the settings page (no secrets: config VALUES +
    //             credential PRESENCE as booleans + the static KB list).
    //   POST:     runtime overrides (in-memory; whitelist: backend,
    //             rerankEnabled, k — lib/settings.js).
    ctx.effect(
      () =>
        server.register({
          kind: "exact",
          path: `${config.routePrefix}/settings`,
          handler: async (req, res) => {
            if (!passFence(req, res)) return;
            if (req.method === "GET" || req.method === "HEAD") {
              const e = eff();
              /** @param {string} ref @returns {Promise<boolean>} resolvable + non-empty */
              const credPresent = async (ref) => {
                if (typeof ref !== "string" || ref === "") return false;
                const hit = await resolveCredential(ref);
                return hit !== undefined && typeof hit.value === "string" && hit.value !== "";
              };
              const [pgCred, embedCred] = await Promise.all([credPresent(e.pgUrlRef), credPresent(e.embeddingKeyRef)]);
              let kbList = [];
              if (overrideList.length > 0) kbList = overrideList;
              else {
                try {
                  kbList = await listKbs();
                } catch {
                  kbList = [];
                }
              }
              log.info("kb: settings read");
              sendJson(res, 200, {
                backend: e.backend,
                rerankEnabled: e.rerankEnabled,
                k: e.k,
                fetchK: e.fetchK,
                topKReranker: e.topKReranker,
                rerankModel: e.rerankModel,
                embeddingModel: e.embeddingModel,
                embeddingUrl: e.embeddingUrl,
                listSource: kbProvider.source,
                overrides: { ...overrides },
                kbList,
                credentials: { pg: pgCred, embed: embedCred },
              });
              return;
            }
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "method-not-allowed" });
              return;
            }
            const body = await readJsonBody(req);
            if (body === null) return badRequest(res);
            if (!validateSettingsBody(body).ok) return badRequest(res);
            applySettingsBody(overrides, body);
            const e = eff();
            log.info(
              `kb: settings override${body.reset === true ? " (reset)" : ""} backend=${e.backend} rerank=${e.rerankEnabled ? "on" : "off"} k=${e.k}`
            );
            sendJson(res, 200, { ok: true, effective: { backend: e.backend, rerankEnabled: e.rerankEnabled, k: e.k } });
          },
        }),
      "kb-query: settings route"
    );

    // ── 5) POST {routePrefix}/settings/test — per-leg connectivity probe ──
    // Three independent legs (PG / embedding / rerank), each soft-failing
    // with a stable code; one leg failing never sinks the others. The
    // response carries fixed codes/messages only — never a secret.
    ctx.effect(
      () =>
        server.register({
          kind: "exact",
          path: `${config.routePrefix}/settings/test`,
          handler: async (req, res) => {
            if (!passFence(req, res)) return;
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "method-not-allowed" });
              return;
            }
            const e = eff();
            const started = Date.now();
            /** @param {unknown} err @returns {string} */
            const codeOf = (err) =>
              err !== null && typeof err === "object" && typeof err.code === "string" && err.code !== "" ? err.code : "error";
            const pgLeg = async () => {
              // 10s guard: a TCP-hanging pg connect cannot be aborted (pg
              // 8.x has no query-level signal); on timeout the pool is torn
              // down so the hung attempt dies with it.
              const timeout = new Promise((_, reject) => {
                const timer = setTimeout(
                  () => reject(Object.assign(new Error("pg probe timed out"), { code: "pg-unreachable" })),
                  10000
                );
                timer.unref?.();
              });
              try {
                const backend = getBackend("pgvector");
                const r = await Promise.race([backend.probe(), timeout]);
                return { ok: true, ms: r.ms };
              } catch (err) {
                try {
                  void backendCache.pgvector?.close?.();
                } catch {
                  /* ignore */
                }
                return { ok: false, error: codeOf(err) };
              }
            };
            const embedLeg = async () => {
              const t0 = Date.now();
              try {
                const keyHit = await resolveCredential(e.embeddingKeyRef);
                const key = keyHit !== undefined ? keyHit.value : "";
                const r = await embedText({
                  base: e.embeddingUrl,
                  model: e.embeddingModel,
                  apiKey: key,
                  text: "kb-query settings probe",
                  timeoutMs: e.timeoutMs,
                });
                return { ok: true, dims: r.dim, ms: Date.now() - t0 };
              } catch (err) {
                return { ok: false, error: codeOf(err) };
              }
            };
            const rerankLeg = async () => {
              const t0 = Date.now();
              try {
                const keyHit = await resolveCredential(RERANK_KEY_REF);
                const key = keyHit !== undefined && typeof keyHit.value === "string" ? keyHit.value : "";
                if (key === "") return { ok: false, error: "rerank-not-configured" };
                const r = await rerankChunks({
                  url: e.rerankUrl,
                  model: e.rerankModel,
                  apiKey: key,
                  query: "probe",
                  chunks: [{ text: "probe a" }, { text: "probe b" }],
                });
                return r.ok ? { ok: true, ms: Date.now() - t0 } : { ok: false, error: r.reason };
              } catch (err) {
                return { ok: false, error: codeOf(err) };
              }
            };
            const [pg, embed, rerank] = await Promise.all([pgLeg(), embedLeg(), rerankLeg()]);
            log.info(
              `kb: settings test pg=${pg.ok ? "ok" : pg.error} embed=${embed.ok ? "ok" : embed.error} rerank=${rerank.ok ? "ok" : rerank.error} ms=${Date.now() - started}`
            );
            sendJson(res, 200, { ok: true, pg, embed, rerank });
          },
        }),
      "kb-query: settings test route"
    );
  }

  // ── 4) kb_search model tool (global; session scope via exec.agent) ─────
  if (tools !== undefined) {
    const tool = makeKbSearchTool({
      backend: finalBackend,
      state,
      limits: { k: () => eff().k, maxChunkChars: config.maxChunkChars, budget: config.contextBudget },
      log,
    });
    ctx.effect(() => tools.register({ ...tool.definition, execute: tool.execute }), "kb-query: kb_search tool");
  }

  log.info(
    `kb: mounted (backend: ${config.backend}, rerank: ${config.rerankEnabled ? "on" : "off"}, list source: ${kbProvider.source}, routes: ${config.routePrefix}[, /select, /query, /settings, /settings/test], ` +
      `trustedHosts: ${config.trustedHosts.length === 0 ? "loopback only" : config.trustedHosts.join(", ")})`
  );
}
