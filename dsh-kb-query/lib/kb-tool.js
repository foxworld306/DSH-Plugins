/**
 * dsh-kb-query — the `kb_search` model tool (factory, pure: no host imports,
 * so the unit tests drive `execute` directly with mock backends/executors).
 *
 * RAG seam (plan §2.4/§2.8/§3.3): the tool is registered GLOBALLY via
 * `ctx.tools.register`; the session scope is taken from the CALLING agent —
 * `exec.agent.session.id` — so the model never passes a session id and two
 * sessions on different KBs never cross (better-sidebar's terminal tools are
 * the precedent, src/tools.ts:1-64).
 *
 * Conventions:
 *  C1 — a raw-registered tool owns its input validation (the host plugin has
 *       no @deepseek-ai/dsh-tools dependency; the definition below is the
 *       raw ToolDefinition shape dsh-tools' register() accepts: name,
 *       description, parameters as raw JSON Schema, mandatory output
 *       {schema, render}, positive-finite timeoutMs, execute).
 *  C4 — `execute` returns ONE canonical JSON value (the output schema);
 *       `render` is a separate pure text projection.
 *  C6 — `exec.signal.throwIfAborted()` before any backend work.
 *
 * Canonical outcomes (the output schema's closed union):
 *  {status:"ok", kb, results:[{text, source?, score?}], truncated,
 *   degraded?:"rerank-unavailable", reason?}   — degraded/reason are present
 *                                              only when the rerank stage
 *                                              fell back to the cosine order
 *  {status:"no-kb-selected", hint}
 *  {status:"backend-error", code, message}   — never throws for backend
 *                                              failures; the model reads it
 *                                              and tells the user.
 * The no-agent case throws a canonical error (precedent: better-sidebar
 * `requireAgent`, tools.ts:54-64) — the registry turns it into the standard
 * error result; such a call cannot belong to a user session anyway.
 */

import { shapeResults } from "./normalize.js";

/** Model-visible tool name. */
export const KB_SEARCH_TOOL_NAME = "kb_search";
/** Hard cap for one query (characters). */
export const QUERY_MAX_CHARS = 500;
/** Declarative per-call deadline (policy metadata; see dsh-tools README). */
export const TOOL_TIMEOUT_MS = 30000;

/**
 * Raw JSON Schema for the tool arguments (the enforced dsh-tools subset:
 * type/properties/required + annotations — no maxLength, so the 500-char
 * cap is enforced in execute, per C1 ownership).
 */
const PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: `The question to search the knowledge base for (required, at most ${QUERY_MAX_CHARS} characters).`,
    },
    k: {
      type: "number",
      description: "Maximum number of chunks to return (optional; values above the configured k are clamped to it).",
    },
  },
  required: ["query"],
};

/**
 * Mandatory canonical output declaration: the closed discriminated union of
 * the three outcomes (dsh-tools validates the returned value against this
 * before it reaches the model).
 */
const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string", const: "ok" },
        kb: { type: "string" },
        results: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              source: { type: "string" },
              score: { type: "number" },
            },
            required: ["text"],
          },
        },
        truncated: { type: "boolean" },
        degraded: {
          type: "string",
          const: "rerank-unavailable",
          description: "Present only when the rerank stage fell back to the pure cosine order (the retrieval itself succeeded).",
        },
        reason: {
          type: "string",
          description: "Short degrade reason (pairs with `degraded`; never carries secrets).",
        },
      },
      required: ["status", "kb", "results", "truncated"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string", const: "no-kb-selected" },
        hint: { type: "string" },
      },
      required: ["status", "hint"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string", const: "backend-error" },
        code: { type: "string" },
        message: { type: "string" },
      },
      required: ["status", "code", "message"],
    },
  ],
};

/**
 * Pure text projection of the canonical value (C4). An `ok` outcome carries
 * a trailing citation reminder: models follow the instruction reliably only
 * when it sits next to the fresh results they are about to cite.
 */
function render(_args, value) {
  const base = JSON.stringify(value, null, 2);
  if (value !== null && typeof value === "object" && value.status === "ok") {
    return [
      {
        type: "text",
        text:
          base +
          "\n\nCitation instruction: when your answer uses a retrieved chunk, place the marker " +
          "kb[<n>] (n = 1-based index into `results` above) immediately after the sentence that " +
          "relies on it — the interface renders these markers as clickable citation chips. Do not " +
          "invent indices outside `results`.",
      },
    ];
  }
  return [{ type: "text", text: base }];
}

/**
 * @typedef {{kind: string, retrieve: (kbId: string, query: string, k: number, opts?: {signal?: AbortSignal}) => Promise<object | Array<object>>}} KbBackend
 *   retrieve RESOLVES to either a plain array of canonical chunks
 *   (bare backends) or a final-selection object
 *   `{results: Array<chunks>, degraded?: "rerank-unavailable", reason?: string}`
 *   (the M1b.5 rerank wrapper), or REJECTS with an Error whose optional
 *   `.code` carries the backend error code (owui-*, pg-*, embed-*, ...).
 */

/**
 * @typedef {{k: number, maxChunkChars: number, budget: number}} KbLimits
 *   k — configured per-call chunk cap; maxChunkChars / budget — shaping
 *   limits (plan §3.3 config.k / maxChunkChars / contextBudget).
 */

/**
 * Build the kb_search tool.
 * @param {{
 *   backend: KbBackend,
 *   state: {get: (sessionId: unknown) => {id: string, name: string} | null},
 *   limits: KbLimits,
 *   log?: {info?: (m: string) => void, warn?: (m: string) => void},
 * }} deps
 * @returns {{
 *   definition: {name: string, description: string, parameters: object, output: {schema: object, render: Function}, timeoutMs: number},
 *   execute: (args: {query?: unknown, k?: unknown}, exec: object) => Promise<object>,
 * }} definition — the raw ToolDefinition WITHOUT execute (the host registers
 * `{...definition, execute}`); execute — the tool body, exposed for the unit
 * tests. Logs carry kbId / query length / result count / duration only —
 * never chunk content and never credentials.
 */
export function makeKbSearchTool({ backend, state, limits, log }) {
  /** Per-call k cap: `limits.k` may be a number or a () => number
   * (the settings page's runtime override is read per call, not at
   * tool-creation time). */
  const kCapOf = () => {
    const raw = typeof limits?.k === "function" ? limits.k() : limits?.k;
    return Math.max(1, Math.floor(raw ?? 8));
  };
  const maxChunkChars = limits?.maxChunkChars ?? 1200;
  const budget = limits?.budget ?? 6000;

  /**
   * @param {{query?: unknown, k?: unknown}} args
   * @param {{signal?: AbortSignal, agent?: {session?: {id?: unknown}}}} exec
   * @returns {Promise<object>} the canonical JSON outcome
   */
  async function execute(args, exec) {
    // C6 — cooperative cancellation before any backend work.
    exec?.signal?.throwIfAborted?.();

    // Session scope from the calling agent (never a model-supplied id).
    const sessionId = exec?.agent?.session?.id;
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new Error("kb_search requires an initiating agent (exec.agent.session.id is missing)");
    }

    // C1 — raw-registered tool owns its argument validation.
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    if (query === "" || query.length > QUERY_MAX_CHARS) {
      throw new Error(`kb_search: query must be a non-empty string of at most ${QUERY_MAX_CHARS} characters`);
    }
    let k = kCapOf();
    if (args?.k !== undefined) {
      if (typeof args.k !== "number" || !Number.isFinite(args.k) || args.k < 1) {
        throw new Error("kb_search: k must be a number >= 1");
      }
      k = Math.min(Math.floor(args.k), kCapOf());
    }

    const kb = state.get(sessionId);
    if (kb === null || kb === undefined) {
      return {
        status: "no-kb-selected",
        hint:
          "The user has not selected a knowledge base for this session (composer knowledge-base selector). " +
          "Answer from your own knowledge, or ask the user to pick one.",
      };
    }

    const started = Date.now();
    try {
      const raw = await backend.retrieve(kb.id, query, k, { signal: exec?.signal });
      // M1b.5: the rerank wrapper resolves to {results, degraded?, reason?};
      // bare backends still resolve to a plain chunk array (both accepted).
      const retrieval = Array.isArray(raw) ? { results: raw } : raw;
      const chunks = Array.isArray(retrieval?.results) ? retrieval.results : [];
      const shaped = shapeResults(chunks, { k, maxChunkChars, budget });
      log?.info?.(
        `kb_search: sid=${sessionId} kbId=${kb.id} queryChars=${query.length} results=${shaped.results.length} truncated=${shaped.truncated}${retrieval?.degraded ? " rerank=degraded" : ""} ms=${Date.now() - started}`
      );
      const outcome = {
        status: "ok",
        kb: kb.name,
        results: shaped.results,
        truncated: shaped.truncated,
      };
      if (retrieval?.degraded === "rerank-unavailable") {
        outcome.degraded = "rerank-unavailable";
        if (typeof retrieval.reason === "string" && retrieval.reason !== "") {
          outcome.reason = retrieval.reason.slice(0, 200);
        }
      }
      return outcome;
    } catch (err) {
      // Canonical error, never a throw: the model can read it and tell the
      // user (plan §3.3). Code comes from the backend (OwuiError.code or a
      // placeholder such as pgvector-not-implemented); message is bounded.
      const code =
        err !== null && typeof err === "object" && typeof err.code === "string" ? err.code : "owui-unreachable";
      const message =
        err !== null && typeof err === "object" && typeof err.message === "string"
          ? err.message.slice(0, 300)
          : "unknown backend error";
      log?.warn?.(`kb_search: backend error sid=${sessionId} kbId=${kb.id} code=${code} ms=${Date.now() - started}`);
      return { status: "backend-error", code, message };
    }
  }

  const definition = {
    name: KB_SEARCH_TOOL_NAME,
    description:
      "Search the company knowledge base for the current session (the active knowledge base is " +
      "chosen by the user in the composer's knowledge-base selector). Call this tool before " +
      "answering questions about company knowledge; each result chunk carries its source. If the " +
      "result has status no-kb-selected, answer from your own knowledge instead. Do not pass a " +
      "session id: the session is taken from the calling agent. Citations: when your answer draws " +
      "on a retrieved chunk, place the marker kb[<n>] (n = 1-based index into results) immediately " +
      "after the sentence that relies on it — the interface renders these markers as clickable " +
      "citation chips and the tool card lists the chunks by the same index; never invent an index " +
      "outside the results array.",
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render },
    timeoutMs: TOOL_TIMEOUT_MS,
  };

  return { definition, execute };
}
