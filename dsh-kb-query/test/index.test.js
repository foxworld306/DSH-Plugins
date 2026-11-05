/**
 * Unit tests for dsh-kb-query (fence / owui client / embed / rerank stage /
 * pgvector backend / kb-list provider / normalize / state / kb_search tool).
 * Run: node test/index.test.js  (from the dsh-kb-query dir)
 *
 * Only the pure lib modules are imported — index.js is NOT in the test
 * surface because its host dependencies (@deepseek-ai/schemastery, cordis
 * context) resolve only inside a dsh profile, not in this sandbox. Network
 * is mocked by overwriting globalThis.fetch per test; the pgvector pool is
 * mocked by an injected fake pool (no pg import in the test environment).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isLoopbackHostname, isTrustedApiRequest } from "../lib/fence.js";
import { classifyError, listKnowledge, retrieve, shapeChunks } from "../lib/owui.js";
import { shapeKbList, shapeResults, shapePgvectorRows } from "../lib/normalize.js";
import { makeSessionKbState } from "../lib/state.js";
import { makeKbSearchTool, KB_SEARCH_TOOL_NAME, QUERY_MAX_CHARS } from "../lib/kb-tool.js";
import { embedText, zeroPad, toVectorLiteral } from "../lib/embed.js";
import { createPgvectorBackend } from "../lib/pgvector.js";
import { normalizeKbListOverride, makeKbListProvider } from "../lib/kb-list.js";
import { rerankChunks, selectFinal, RERANK_DEGRADED, RERANK_DOC_MAX_CHARS } from "../lib/rerank.js";
import { validateSettingsBody, applySettingsBody } from "../lib/settings.js";

// ── fence ──────────────────────────────────────────────────────────────────

/** @param {{host?: string, origin?: string, headers?: object}} parts */
function fenceReq({ host, origin, headers = {} } = {}) {
  const h = { ...headers };
  if (host !== undefined) h.host = host;
  if (origin !== undefined) h.origin = origin;
  return { headers: h };
}

test("fence: loopback Host passes (127.x and localhost)", () => {
  assert.equal(isTrustedApiRequest(fenceReq({ host: "127.0.0.1:3080" }), []), true);
  assert.equal(isTrustedApiRequest(fenceReq({ host: "127.5.6.7" }), []), true);
  assert.equal(isTrustedApiRequest(fenceReq({ host: "localhost:3080" }), []), true);
  assert.equal(isTrustedApiRequest(fenceReq({ host: "[::1]:3080" }), []), true);
});

test("fence: non-loopback without trustedHosts is refused", () => {
  assert.equal(isTrustedApiRequest(fenceReq({ host: "dsh.contoso.com:8080" }), []), false);
  assert.equal(isTrustedApiRequest(fenceReq({}), []), false, "missing Host is refused");
});

test("fence: non-loopback with a trustedHosts entry passes (exact and port-less)", () => {
  assert.equal(isTrustedApiRequest(fenceReq({ host: "dsh.contoso.com:8080" }), ["dsh.contoso.com"]), true);
  assert.equal(isTrustedApiRequest(fenceReq({ host: "dsh.contoso.com:9999" }), ["dsh.contoso.com"]), true, "port-less entry matches any port");
  assert.equal(isTrustedApiRequest(fenceReq({ host: "dsh.contoso.com:8080" }), ["dsh.contoso.com:8080"]), true, "exact entry matches");
  assert.equal(isTrustedApiRequest(fenceReq({ host: "dsh.contoso.com:9999" }), ["dsh.contoso.com:8080"]), false, "exact entry re-decides on port");
});

test("fence: sec-fetch-site cross-site is refused even on loopback", () => {
  assert.equal(
    isTrustedApiRequest(fenceReq({ host: "127.0.0.1:3080", headers: { "sec-fetch-site": "cross-site" } }), []),
    false
  );
  assert.equal(
    isTrustedApiRequest(fenceReq({ host: "127.0.0.1:3080", headers: { "sec-fetch-site": "same-origin" } }), []),
    true
  );
});

test("fence: Origin same hostname on a different port passes", () => {
  assert.equal(isTrustedApiRequest(fenceReq({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:9999" }), []), true);
});

test("fence: Origin on another hostname / opaque / malformed is refused", () => {
  assert.equal(isTrustedApiRequest(fenceReq({ host: "127.0.0.1:3080", origin: "http://other.example" }), []), false);
  assert.equal(isTrustedApiRequest(fenceReq({ host: "127.0.0.1:3080", origin: "null" }), []), false);
  assert.equal(isTrustedApiRequest(fenceReq({ host: "127.0.0.1:3080", origin: "not a url" }), []), false);
});

test("fence: isLoopbackHostname", () => {
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("[::1]"), true);
  assert.equal(isLoopbackHostname("10.0.0.2"), false);
  assert.equal(isLoopbackHostname("1270.0.0.1"), false);
  assert.equal(isLoopbackHostname("127.0.0"), false);
});

// ── owui client ────────────────────────────────────────────────────────────

/** @param {(url: string, opts: object, n: number) => object} handler */
function mockFetch(handler) {
  const calls = [];
  /** @param {string} url @param {object} [opts] */
  const fn = (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts, calls.length);
  };
  fn.calls = calls;
  return fn;
}

/** @param {number} status @param {object} body */
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Run fn with globalThis.fetch replaced. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("owui.listKnowledge: 200 shapes to [{id, name, description?}] (name fallback)", async () => {
  const fetchMock = mockFetch(() =>
    jsonResponse(200, [
      { id: "kb-1", name: "HR", description: "Policies" },
      { id: "kb-2" },
      { nope: true },
    ])
  );
  const kbs = await withFetch(fetchMock, () => listKnowledge({ base: "http://owui.test", token: "tok" }));
  assert.deepEqual(kbs, [
    { id: "kb-1", name: "HR", description: "Policies" },
    { id: "kb-2", name: "kb-2" },
  ]);
});

test("owui: sends the Bearer token, normalizes the base URL", async () => {
  const fetchMock = mockFetch(() => jsonResponse(200, []));
  await withFetch(fetchMock, () => listKnowledge({ base: "http://owui.test///", token: "sekret-token" }));
  const call = fetchMock.calls[0];
  assert.equal(call.opts.headers.authorization, "Bearer sekret-token");
  assert.equal(call.url, "http://owui.test/api/v1/knowledge/");
});

test("owui.listKnowledge: 500 → OwuiError owui-error:500 (passthrough)", async () => {
  const fetchMock = mockFetch(() => jsonResponse(500, { detail: "boom" }));
  const err = await withFetch(fetchMock, async () => {
    try {
      await listKnowledge({ base: "http://owui.test", token: "tok" });
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.equal(err.code, "owui-error:500");
  assert.equal(classifyError(err, "list").code, "owui-error:500");
});

test("owui: network failure classifies as owui-unreachable without leaking the token", async () => {
  const fetchMock = mockFetch(() => {
    const e = new TypeError("fetch failed");
    e.cause = new Error("ECONNREFUSED");
    throw e;
  });
  const err = await withFetch(fetchMock, async () => {
    try {
      await listKnowledge({ base: "http://owui.test", token: "super-secret-token" });
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.equal(err.code, "owui-unreachable");
  assert.ok(!String(err.message).includes("super-secret-token"), "token must not leak into the message");
});

test("owui: timeout (AbortError) classifies as owui-unreachable", async () => {
  const fetchMock = mockFetch((url, opts) =>
    new Promise((resolve, reject) => {
      const signal = opts.signal;
      if (signal === undefined) return; // hang forever unless the deadline fires
      if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })
  );
  const err = await withFetch(fetchMock, async () => {
    try {
      await listKnowledge({ base: "http://owui.test", token: "tok", timeoutMs: 30 });
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.equal(err.code, "owui-unreachable");
});

test("owui.retrieve: 200 defensive parsing (wrapper, content/meta_data, source keys)", async () => {
  const fetchMock = mockFetch(() =>
    jsonResponse(200, {
      results: [
        { content: "chunk one", meta_data: { source: "hr.pdf", _score: 0.9 }, score: 0.9 },
        { text: "chunk two", metadata: { file_name: "it.pdf" } },
        { content: "chunk three", meta_data: { filename: "fin.xlsx" }, distance: 1.2 },
        { whatever: true },
      ],
    })
  );
  const chunks = await withFetch(fetchMock, () =>
    retrieve({ base: "http://owui.test", token: "tok", collectionName: "kb-1", query: "q", k: 5 })
  );
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].text, "chunk one");
  assert.equal(chunks[0].source, "hr.pdf");
  assert.equal(chunks[0].score, 0.9);
  assert.equal(chunks[1].text, "chunk two");
  assert.equal(chunks[1].source, "it.pdf");
  assert.ok(!("score" in chunks[1]));
  assert.equal(chunks[2].source, "fin.xlsx");
  assert.equal(chunks[2].score, 1.2, "raw distance passes through; normalize applies the 0..1 honesty filter");
  const call = fetchMock.calls[0];
  assert.equal(call.opts.method, "POST");
  assert.deepEqual(JSON.parse(call.opts.body), { collection_name: "kb-1", query: "q", k: 5 });
});

test("shapeChunks: bare array body, text under text key", () => {
  assert.deepEqual(shapeChunks([{ text: "a" }, { content: "b" }]), [{ text: "a" }, { text: "b" }]);
  assert.deepEqual(shapeChunks({ noList: true }), [], "unrecognized body → no chunks (defensive)");
});

test("classifyError: passthrough / abort / TypeError / generic", () => {
  const e1 = Object.assign(new Error("x"), { code: "owui-error:404" });
  assert.equal(classifyError(e1, "retrieve").code, "owui-error:404");
  const e2 = new DOMException("Aborted", "AbortError");
  assert.equal(classifyError(e2, "list").code, "owui-unreachable");
  assert.equal(classifyError(new TypeError("fetch failed"), "list").code, "owui-unreachable");
  assert.equal(classifyError(new Error("weird"), "list").code, "owui-unreachable");
  assert.equal(classifyError(undefined, "list").code, "owui-unreachable");
});

// ── normalize ──────────────────────────────────────────────────────────────

test("shapeResults: per-chunk truncation to maxChunkChars", () => {
  const { results, truncated } = shapeResults([{ text: "a".repeat(2000), source: "s" }], {
    k: 4,
    maxChunkChars: 500,
    budget: 10000,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].text.length, 500);
  assert.equal(truncated, true);
});

test("shapeResults: k cap drops the tail and flags truncated", () => {
  const raw = Array.from({ length: 5 }, (_, i) => ({ text: `t${i}` }));
  const { results, truncated } = shapeResults(raw, { k: 2, maxChunkChars: 100, budget: 1000 });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.text), ["t0", "t1"]);
  assert.equal(truncated, true);
});

test("shapeResults: budget cuts the tail chunk and flags truncated", () => {
  const raw = [{ text: "aaaa" }, { text: "bbbb" }, { text: "cccc" }, { text: "dddd" }];
  const { results, truncated } = shapeResults(raw, { k: 8, maxChunkChars: 100, budget: 10 });
  assert.equal(truncated, true);
  const total = results.reduce((n, r) => n + r.text.length, 0);
  assert.ok(total <= 10, `total ${total} must stay within budget`);
  assert.equal(results[results.length - 1].text, "cc", "the budget-exceeding chunk is cut, not dropped");
});

test("shapeResults: zero budget drops everything", () => {
  const { results, truncated } = shapeResults([{ text: "a" }], { k: 8, maxChunkChars: 100, budget: 0 });
  assert.deepEqual(results, []);
  assert.equal(truncated, true);
});

test("shapeResults: score honesty — distances / negatives / missing are omitted, never fabricated", () => {
  const raw = [
    { text: "a", score: 0.87 },
    { text: "b", score: 1.4 },
    { text: "c", score: -0.2 },
    { text: "d" },
  ];
  const { results } = shapeResults(raw, { k: 8, maxChunkChars: 100, budget: 1000 });
  assert.equal(results.length, 4);
  assert.equal(results[0].score, 0.87);
  assert.ok(!("score" in results[1]), "cosine distance 1.4 must be omitted");
  assert.ok(!("score" in results[2]), "out-of-scale score must be omitted");
  assert.ok(!("score" in results[3]), "absent score must not be invented");
});

test("shapeResults: clean passthrough is not truncated", () => {
  const { results, truncated } = shapeResults([{ text: "a", source: "s", score: 0.5 }], {
    k: 8,
    maxChunkChars: 100,
    budget: 100,
  });
  assert.deepEqual(results, [{ text: "a", source: "s", score: 0.5 }]);
  assert.equal(truncated, false);
});

test("shapeResults: empty/invalid input is safe", () => {
  assert.deepEqual(shapeResults(null, { k: 4, maxChunkChars: 10, budget: 100 }), { results: [], truncated: false });
  assert.deepEqual(shapeResults("nope", {}), { results: [], truncated: false });
  const { results, truncated } = shapeResults([{ text: "" }], { k: 4, maxChunkChars: 10, budget: 100 });
  assert.deepEqual(results, []);
  assert.equal(truncated, true, "a chunk without usable text is lost → truncated");
});

test("shapeKbList: array, wrapper, name fallback, dedupe, malformed", () => {
  assert.deepEqual(shapeKbList([{ id: "1", name: "A" }, { id: "2" }, { id: "1", name: "dup" }]), [
    { id: "1", name: "A" },
    { id: "2", name: "2" },
  ]);
  assert.deepEqual(shapeKbList({ items: [{ id: "9", description: "d" }] }), [
    { id: "9", name: "9", description: "d" },
  ]);
  assert.throws(() => shapeKbList({ nope: true }), /unexpected response shape/);
});

// ── state ──────────────────────────────────────────────────────────────────

test("state: per-session isolation", () => {
  const st = makeSessionKbState();
  st.set("s1", { id: "kb-a", name: "A" });
  st.set("s2", { id: "kb-b", name: "B" });
  assert.deepEqual(st.get("s1"), { id: "kb-a", name: "A" });
  assert.deepEqual(st.get("s2"), { id: "kb-b", name: "B" });
  assert.equal(st.size, 2);
});

test("state: whitelist validation (array and Set forms)", () => {
  const st = makeSessionKbState();
  assert.throws(() => st.set("s1", { id: "kb-x", name: "X" }, ["kb-a", "kb-b"]));
  st.set("s1", { id: "kb-a", name: "A" }, new Set(["kb-a", "kb-b"]));
  assert.deepEqual(st.get("s1"), { id: "kb-a", name: "A" });
});

test("state: null clears; name falls back to id; clear/clearAll", () => {
  const st = makeSessionKbState();
  st.set("s1", { id: "kb-a", name: "A" });
  st.set("s1", null);
  assert.equal(st.get("s1"), null);
  assert.equal(st.size, 0);
  st.set("s1", { id: "kb-a" });
  assert.equal(st.get("s1").name, "kb-a", "missing name falls back to the id");
  st.clear("s1");
  assert.equal(st.size, 0);
  st.set("s1", { id: "kb-a", name: "A" });
  st.clearAll();
  assert.equal(st.size, 0);
});

test("state: malformed input throws; non-string session reads null", () => {
  const st = makeSessionKbState();
  assert.throws(() => st.set("", { id: "a" }));
  assert.throws(() => st.set("s1", { id: "" }));
  assert.equal(st.set("s1", null, ["x"]), true, "null clears even when a whitelist is given");
  assert.equal(st.get(123), null);
  assert.equal(st.get(undefined), null);
});

// ── kb_search tool ─────────────────────────────────────────────────────────

const LIMITS = { k: 8, maxChunkChars: 1200, budget: 6000 };

/** A test backend: "boom" rejects with a coded error, otherwise two chunks. */
function okBackend(received) {
  return {
    kind: "test",
    /** @param {string} kbId @param {string} query @param {number} k */
    async retrieve(kbId, query, k) {
      if (received !== undefined) received.push({ kbId, query, k });
      if (query === "boom") {
        const e = new Error("backend exploded");
        e.code = "owui-error:500";
        throw e;
      }
      return [
        { text: `result for ${query} in ${kbId}`, source: "doc.pdf", score: 0.91 },
        { text: "second chunk" },
      ];
    },
  };
}

/** @param {{agent?: object}} [parts] */
function makeExec({ agent } = {}) {
  return {
    token: Symbol("tok"),
    callId: "c1",
    name: KB_SEARCH_TOOL_NAME,
    arguments: {},
    signal: new AbortController().signal,
    agent,
  };
}

test("kb-tool: no agent → canonical error (rejects, does not resolve)", async () => {
  const { execute } = makeKbSearchTool({ backend: okBackend(), state: makeSessionKbState(), limits: LIMITS });
  await assert.rejects(() => execute({ query: "hi" }, makeExec({ agent: undefined })), /agent/);
});

test("kb-tool: no active KB → no-kb-selected with a hint", async () => {
  const st = makeSessionKbState();
  const { execute } = makeKbSearchTool({ backend: okBackend(), state: st, limits: LIMITS });
  const out = await execute({ query: "hi" }, makeExec({ agent: { session: { id: "s1" } } }));
  assert.equal(out.status, "no-kb-selected");
  assert.equal(typeof out.hint, "string");
  assert.ok(out.hint.length > 0);
});

test("kb-tool: backend throw → backend-error JSON, never throws", async () => {
  const st = makeSessionKbState();
  st.set("s1", { id: "kb-1", name: "KB One" });
  const { execute } = makeKbSearchTool({ backend: okBackend(), state: st, limits: LIMITS });
  const out = await execute({ query: "boom" }, makeExec({ agent: { session: { id: "s1" } } }));
  assert.deepEqual(out, { status: "backend-error", code: "owui-error:500", message: "backend exploded" });
});

test("kb-tool: happy path → canonical ok JSON (source kept, second score omitted)", async () => {
  const st = makeSessionKbState();
  st.set("s1", { id: "kb-1", name: "KB One" });
  const { execute } = makeKbSearchTool({ backend: okBackend(), state: st, limits: LIMITS });
  const out = await execute({ query: "what is the policy" }, makeExec({ agent: { session: { id: "s1" } } }));
  assert.equal(out.status, "ok");
  assert.equal(out.kb, "KB One");
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].source, "doc.pdf");
  assert.equal(out.results[0].score, 0.91);
  assert.ok(!("score" in out.results[1]));
  assert.equal(out.truncated, false);
});

test("kb-tool: per-session isolation (s2 sees no KB while s1 does)", async () => {
  const st = makeSessionKbState();
  st.set("s1", { id: "kb-1", name: "KB One" });
  const { execute } = makeKbSearchTool({ backend: okBackend(), state: st, limits: LIMITS });
  const out = await execute({ query: "hi" }, makeExec({ agent: { session: { id: "s2" } } }));
  assert.equal(out.status, "no-kb-selected");
});

test("kb-tool: k clamped to the configured cap", async () => {
  const received = [];
  const st = makeSessionKbState();
  st.set("s1", { id: "kb-1", name: "KB One" });
  const { execute } = makeKbSearchTool({ backend: okBackend(received), state: st, limits: { k: 4, maxChunkChars: 100, budget: 500 } });
  const out = await execute({ query: "hi", k: 50 }, makeExec({ agent: { session: { id: "s1" } } }));
  assert.equal(out.status, "ok");
  assert.equal(received[0].k, 4, "k is clamped down to the configured cap");
});

test("kb-tool: invalid args → canonical error (empty / overlong / bad k)", async () => {
  const st = makeSessionKbState();
  st.set("s1", { id: "kb-1", name: "KB One" });
  const { execute } = makeKbSearchTool({ backend: okBackend(), state: st, limits: LIMITS });
  const exec = makeExec({ agent: { session: { id: "s1" } } });
  await assert.rejects(() => execute({ query: "   " }, exec), /query/);
  await assert.rejects(() => execute({ query: "x".repeat(QUERY_MAX_CHARS + 1) }, exec), /query/);
  await assert.rejects(() => execute({ query: "hi", k: 0 }, exec), /k/);
  await assert.rejects(() => execute({ query: "hi", k: "four" }, exec), /k/);
});

test("kb-tool: backend throw with a stable code → backend-error with code passthrough", async () => {
  const pg = {
    kind: "pgvector",
    retrieve() {
      const e = new Error("kb DSN credential is not configured");
      e.code = "pg-not-configured";
      return Promise.reject(e);
    },
  };
  const st = makeSessionKbState();
  st.set("s1", { id: "kb-1", name: "KB One" });
  const { execute } = makeKbSearchTool({ backend: pg, state: st, limits: LIMITS });
  const out = await execute({ query: "hi" }, makeExec({ agent: { session: { id: "s1" } } }));
  assert.equal(out.status, "backend-error");
  assert.equal(out.code, "pg-not-configured");
});

test("kb-tool: definition is a register-ready raw ToolDefinition", () => {
  const { definition } = makeKbSearchTool({ backend: okBackend(), state: makeSessionKbState(), limits: LIMITS });
  assert.equal(definition.name, KB_SEARCH_TOOL_NAME);
  assert.equal(definition.timeoutMs, 30000, "mandatory positive-finite timeoutMs");
  assert.equal(typeof definition.description, "string");
  assert.equal(definition.parameters.type, "object");
  assert.deepEqual(definition.parameters.required, ["query"]);
  assert.equal(definition.parameters.properties.query.type, "string");
  assert.equal(definition.parameters.properties.k.type, "number");
  // mandatory output declaration: schema (closed union) + pure render
  assert.ok(Array.isArray(definition.output.schema.oneOf) && definition.output.schema.oneOf.length === 3);
  assert.equal(typeof definition.output.render, "function");
  const content = definition.output.render({}, { status: "no-kb-selected", hint: "h" });
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
  assert.match(content[0].text, /no-kb-selected/);
});

test("kb-tool: M1b.5 object-shaped retrieve (rerank wrapper) → degraded/reason pass-through; bare arrays still work", async () => {
  const st = makeSessionKbState();
  st.set("s1", { id: "kb-1", name: "KB One" });
  const wrapperBackend = {
    kind: "pgvector",
    async retrieve() {
      return {
        results: [{ text: "c1", source: "s.pdf", score: 0.0459 }, { text: "c2", score: 0.006 }],
        degraded: "rerank-unavailable",
        reason: "rerank endpoint responded 502",
      };
    },
  };
  const { execute } = makeKbSearchTool({ backend: wrapperBackend, state: st, limits: LIMITS });
  const out = await execute({ query: "hi" }, makeExec({ agent: { session: { id: "s1" } } }));
  assert.equal(out.status, "ok");
  assert.equal(out.degraded, "rerank-unavailable");
  assert.equal(out.reason, "rerank endpoint responded 502");
  assert.equal(out.results.length, 2, "degraded retrieval still returns the cosine top-k");
  // A bare-array backend must keep working (both shapes accepted).
  const bare = { kind: "owui", async retrieve() { return [{ text: "x", score: 0.7 }]; } };
  const st2 = makeSessionKbState();
  st2.set("s2", { id: "kb-2", name: "KB Two" });
  const out2 = await makeKbSearchTool({ backend: bare, state: st2, limits: LIMITS }).execute(
    { query: "hi" },
    makeExec({ agent: { session: { id: "s2" } } })
  );
  assert.equal(out2.status, "ok");
  assert.ok(!("degraded" in out2), "no degraded flag on the plain path");
});

// ── embed (M1b) ────────────────────────────────────────────────────────────

/** @param {number[]} vector */
function embedFetchOk(vector) {
  return () => Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [{ embedding: vector }] }) });
}

test("embed: success — 768-dim vector, exact URL, Bearer header, {model, input} body", async () => {
  const calls = [];
  const fetchImpl = (url, opts) => {
    calls.push({ url: String(url), opts });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [{ embedding: Array.from({ length: 768 }, () => 0.5) }] }) });
  };
  const out = await embedText({
    base: "https://gw.test/v1/",
    apiKey: "fake-key-1",
    model: "bce-embedding-base_v1",
    text: "hello",
    timeoutMs: 5000,
    fetchImpl,
  });
  assert.equal(out.dim, 768);
  assert.equal(out.vector.length, 768);
  assert.equal(calls[0].url, "https://gw.test/v1/embeddings", "base (incl. /v1) + /embeddings, trailing slash stripped");
  assert.equal(calls[0].opts.headers.authorization, "Bearer fake-key-1");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { model: "bce-embedding-base_v1", input: "hello" });
});

test("embed: keyless (apiKey \"\") → no authorization header", async () => {
  const calls = [];
  const fetchImpl = (url, opts) => {
    calls.push({ opts });
    return embedFetchOk([0.1])(url, opts);
  };
  await embedText({ base: "https://gw.test/v1", apiKey: "", model: "m", text: "hi", fetchImpl });
  assert.ok(!("authorization" in calls[0].opts.headers), "no Authorization header when keyless");
});

test("embed: HTTP 401 → embed-error:401", async () => {
  await assert.rejects(
    () =>
      embedText({
        base: "https://gw.test/v1",
        model: "m",
        text: "hi",
        fetchImpl: () => Promise.resolve({ ok: false, status: 401, text: async () => "denied" }),
      }),
    (err) => err.code === "embed-error:401"
  );
});

test("embed: missing data[0].embedding → embed-shape", async () => {
  await assert.rejects(
    () => embedText({ base: "https://gw.test/v1", model: "m", text: "hi", fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) }) }),
    (err) => err.code === "embed-shape"
  );
  await assert.rejects(
    () => embedText({ base: "https://gw.test/v1", model: "m", text: "hi", fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [0.1, NaN] }] }) }) }),
    (err) => err.code === "embed-shape", "non-finite element is a shape error"
  );
});

test("embed: malformed JSON body → embed-shape", async () => {
  await assert.rejects(
    () =>
      embedText({
        base: "https://gw.test/v1",
        model: "m",
        text: "hi",
        fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }),
      }),
    (err) => err.code === "embed-shape"
  );
});

test("embed: empty base → embed-not-configured, no fetch", async () => {
  const fetchImpl = () => { throw new Error("must not be called"); };
  await assert.rejects(
    () => embedText({ base: "", model: "m", text: "hi", fetchImpl }),
    (err) => err.code === "embed-not-configured"
  );
  await assert.rejects(
    () => embedText({ base: "https://gw.test/v1", model: "", text: "hi", fetchImpl }),
    (err) => err.code === "embed-not-configured"
  );
});

test("embed: network failure → embed-unreachable (no key in the message)", async () => {
  await assert.rejects(
    () => embedText({ base: "https://gw.test/v1", apiKey: "fake-key-1", model: "m", text: "hi", fetchImpl: () => Promise.reject(new TypeError("fetch failed")) }),
    (err) => {
      assert.equal(err.code, "embed-unreachable");
      assert.ok(!err.message.includes("fake-key-1"), "the key never leaks into the message");
      return true;
    }
  );
});

test("zeroPad: 768→1532 pads zeros; equal dim returns the input as-is; longer throws", () => {
  const v = Array.from({ length: 768 }, (_, i) => i + 1);
  const padded = zeroPad(v, 1532);
  assert.equal(padded.length, 1532);
  assert.equal(padded[0], 1);
  assert.equal(padded[767], 768);
  assert.equal(padded[768], 0);
  assert.equal(padded[1531], 0);
  assert.equal(zeroPad(v, 768), v, "equal dim → the same array, no copy");
  assert.throws(() => zeroPad(Array(1533).fill(0), 1532), (e) => e.code === "embed-shape", "longer than the column dim must not reach SQL");
});

test("toVectorLiteral: pgvector 0.8.x bracket form [a,b,c]", () => {
  assert.equal(toVectorLiteral([0.1, 2, 0]), "[0.1,2,0]");
  assert.throws(() => toVectorLiteral([]), (e) => e.code === "embed-shape");
  assert.throws(() => toVectorLiteral([1, NaN]), (e) => e.code === "embed-shape");
});

// ── rerank stage (M1b.5, mock fetch) ───────────────────────────────────────

/**
 * Mock fetch for the rerank endpoint.
 * @param {object} [opts]
 * @param {object} [opts.body] the parsed JSON body to return
 * @param {boolean} [opts.ok] res.ok
 * @param {number} [opts.status] res.status
 * @param {Error} [opts.throw] reject with this error (network / timeout)
 * @param {boolean} [opts.throwJson] make res.json() reject (bad JSON)
 */
function rerankFetch(opts = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (opts.throw) throw opts.throw;
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => {
        if (opts.throwJson) throw new Error("SyntaxError: bad JSON");
        return opts.body;
      },
      text: async () => "",
    };
  };
  return { fn, calls };
}

const RERANK_CANDIDATES = [
  { text: "candidate A", source: "a.pdf", score: 0.55 },
  { text: "candidate B", source: "b.pdf", score: 0.54 },
  { text: "candidate C", source: "c.pdf", score: 0.53 },
];

test("rerank: out-of-order endpoint response is re-ranked by relevance_score (stable safety net)", async () => {
  // Contract says DESC, but a drifted gateway might return C,A,B — the final
  // selection must still be ranked by relevance_score (B 0.9 > A 0.7 > C 0.1).
  const { fn } = rerankFetch({
    body: {
      results: [
        { index: 2, relevance_score: 0.1 },
        { index: 0, relevance_score: 0.7 },
        { index: 1, relevance_score: 0.9 },
      ],
    },
  });
  const out = await selectFinal({
    candidates: RERANK_CANDIDATES,
    query: "q",
    k: 8,
    topK: 5,
    rerank: { url: "u", model: "m", apiKey: "k", fetchImpl: fn },
  });
  assert.ok(!("degraded" in out));
  assert.deepEqual(out.results.map((c) => c.text), ["candidate B", "candidate A", "candidate C"]);
  assert.deepEqual(out.results.map((c) => c.score), [0.9, 0.7, 0.1]);
});

test("rerank: normal 200 → reorders by relevance, replaces score, caps at min(k, topK)", async () => {
  // Endpoint returns B (0.9) > A (0.7) > C (0.1), all candidates scored.
  const { fn, calls } = rerankFetch({
    body: {
      results: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.7 },
        { index: 2, relevance_score: 0.1 },
      ],
    },
  });
  const out = await selectFinal({
    candidates: RERANK_CANDIDATES,
    query: "q",
    k: 8,
    topK: 5,
    rerank: { url: "https://gw.test/v1/rerank", model: "bge-reranker-v2-m3", apiKey: "key", fetchImpl: fn },
  });
  assert.equal(calls.length, 1, "exactly one rerank request");
  assert.ok(!("degraded" in out), "no degrade on success");
  // Reordered B, A, C and scores replaced by relevance_score.
  assert.deepEqual(out.results.map((c) => c.text), ["candidate B", "candidate A", "candidate C"]);
  assert.deepEqual(out.results.map((c) => c.score), [0.9, 0.7, 0.1]);
  // Request contract: POST, Bearer key, {model, query, documents}.
  const { url, init } = calls[0];
  assert.equal(url, "https://gw.test/v1/rerank");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, "Bearer key");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "bge-reranker-v2-m3");
  assert.equal(body.query, "q");
  assert.deepEqual(body.documents, ["candidate A", "candidate B", "candidate C"]);
  assert.ok(init.signal instanceof AbortSignal, "AbortController timeout signal present");
  // Cap = min(k=8, topK=5) = 5, but only 3 candidates → all 3.
  assert.equal(out.results.length, 3);
});

test("rerank: non-200 → degrades to cosine order, keeps original scores, adds degraded + reason", async () => {
  const { fn, calls } = rerankFetch({ ok: false, status: 503 });
  const out = await selectFinal({
    candidates: RERANK_CANDIDATES,
    query: "q",
    k: 8,
    topK: 5,
    rerank: { url: "https://gw.test/v1/rerank", model: "m", apiKey: "key", fetchImpl: fn },
    log: { warn() {} },
  });
  assert.equal(calls.length, 1);
  assert.equal(out.degraded, RERANK_DEGRADED);
  assert.match(out.reason, /503/);
  // Cosine order preserved (A, B, C) with the ORIGINAL cosine scores.
  assert.deepEqual(out.results.map((c) => c.text), ["candidate A", "candidate B", "candidate C"]);
  assert.deepEqual(out.results.map((c) => c.score), [0.55, 0.54, 0.53]);
});

test("rerank: out-of-range index → degrades (never indexes a non-existent candidate)", async () => {
  const { fn } = rerankFetch({
    body: {
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.8 },
        { index: 7, relevance_score: 0.7 },
      ],
    },
  });
  const out = await selectFinal({
    candidates: RERANK_CANDIDATES,
    query: "q",
    k: 8,
    topK: 5,
    rerank: { url: "https://gw.test/v1/rerank", model: "m", apiKey: "key", fetchImpl: fn },
    log: { warn() {} },
  });
  assert.equal(out.degraded, RERANK_DEGRADED);
  assert.match(out.reason, /index/);
  assert.deepEqual(out.results.map((c) => c.text), ["candidate A", "candidate B", "candidate C"], "cosine order on degrade");
});

test("rerank: timeout / network error / bad JSON / missing results all degrade (never throw)", async () => {
  const log = { warn() {} };
  const base = { url: "https://gw.test/v1/rerank", model: "m", apiKey: "k" };
  // timeout (AbortSignal → TimeoutError)
  let out = await selectFinal({ candidates: RERANK_CANDIDATES, query: "q", k: 5, topK: 5, rerank: { ...base, fetchImpl: rerankFetch({ throw: Object.assign(new Error("aborted"), { name: "TimeoutError" }) }).fn }, log });
  assert.equal(out.degraded, RERANK_DEGRADED);
  assert.match(out.reason, /timed out/i);
  // network unreachable (TypeError)
  out = await selectFinal({ candidates: RERANK_CANDIDATES, query: "q", k: 5, topK: 5, rerank: { ...base, fetchImpl: rerankFetch({ throw: new TypeError("fetch failed") }).fn }, log });
  assert.equal(out.degraded, RERANK_DEGRADED);
  assert.match(out.reason, /unreachable/i);
  // bad JSON
  out = await selectFinal({ candidates: RERANK_CANDIDATES, query: "q", k: 5, topK: 5, rerank: { ...base, fetchImpl: rerankFetch({ throwJson: true }).fn }, log });
  assert.equal(out.degraded, RERANK_DEGRADED);
  assert.match(out.reason, /JSON/);
  // missing results array
  out = await selectFinal({ candidates: RERANK_CANDIDATES, query: "q", k: 5, topK: 5, rerank: { ...base, fetchImpl: rerankFetch({ body: {} }).fn }, log });
  assert.equal(out.degraded, RERANK_DEGRADED);
  assert.match(out.reason, /results/);
  // In every case the cosine top-k is still served (retrieval never fails).
  assert.equal(out.results.length, RERANK_CANDIDATES.length, "cosine candidates still served after the last degrade");
});

test("rerank: not triggered without a key / with empty candidates (no fetch, no degraded flag)", async () => {
  const { fn, calls } = rerankFetch({ body: { results: [] } });
  // Empty candidates → no rerank call, no degraded.
  let out = await selectFinal({ candidates: [], query: "q", k: 5, topK: 5, rerank: { url: "u", model: "m", apiKey: "k", fetchImpl: fn }, log: { warn() {} } });
  assert.equal(calls.length, 0, "no fetch when there are no candidates");
  assert.ok(!("degraded" in out));
  assert.equal(out.results.length, 0);
  // No rerank config at all → pure cosine top-k, no fetch.
  const { fn: fn2, calls: calls2 } = rerankFetch({ body: { results: [] } });
  out = await selectFinal({ candidates: RERANK_CANDIDATES, query: "q", k: 2, topK: 5, rerank: null, fetchImpl: fn2, log: { warn() {} } });
  assert.equal(calls2.length, 0);
  assert.ok(!("degraded" in out));
  assert.equal(out.results.length, 2, "k=2 caps the cosine order");
});

test("rerank: final cap is min(k, topK); topK clamped to 20", async () => {
  const five = RERANK_CANDIDATES.concat([
    { text: "d", score: 0.5 },
    { text: "e", score: 0.49 },
  ]);
  const ok = { body: { results: five.map((_, i) => ({ index: i, relevance_score: 1 - i * 0.1 })) } };
  // k=8, topK=5 → 5
  let out = await selectFinal({ candidates: five, query: "q", k: 8, topK: 5, rerank: { url: "u", model: "m", apiKey: "k", fetchImpl: rerankFetch(ok).fn } });
  assert.equal(out.results.length, 5);
  // k=3, topK=5 → 3
  out = await selectFinal({ candidates: five, query: "q", k: 3, topK: 5, rerank: { url: "u", model: "m", apiKey: "k", fetchImpl: rerankFetch(ok).fn } });
  assert.equal(out.results.length, 3);
  // topK=99 → clamped 20, k=40 → min(40,20)=20 but only 5 candidates → 5
  out = await selectFinal({ candidates: five, query: "q", k: 40, topK: 99, rerank: { url: "u", model: "m", apiKey: "k", fetchImpl: rerankFetch(ok).fn } });
  assert.equal(out.results.length, 5);
});

test("rerank: documents are truncated to RERANK_DOC_MAX_CHARS (defensive)", async () => {
  const longText = "x".repeat(RERANK_DOC_MAX_CHARS + 500);
  const { fn, calls } = rerankFetch({ body: { results: [{ index: 0, relevance_score: 0.5 }] } });
  await selectFinal({
    candidates: [{ text: longText, score: 0.5 }],
    query: "q",
    k: 1,
    topK: 5,
    rerank: { url: "u", model: "m", apiKey: "k", fetchImpl: fn },
  });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.documents[0].length, RERANK_DOC_MAX_CHARS, "overlong doc truncated before the wire");
});

// ── pgvector backend (M1b, fake pool) ──────────────────────────────────────

/**
 * Fake pg pool + client capturing every query.
 * @param {object} [opts]
 * @param {object[]} [opts.rows] rows returned by the top-k query
 * @param {boolean} [opts.rejectConnect] make pool.connect() throw
 * @param {number[]} [opts.dimSequence] stored dims returned by successive
 *   sample-row dim probes (last value sticks); default always 1536
 * @param {boolean} [opts.dimReject] sample-row probe returns no rows (empty collection)
 * @param {number} [opts.catalogDim] catalog typmod dim (atttypmod - 4); default 1532
 * @param {boolean} [opts.catalogReject] catalog probe returns no usable dim
 * @param {{code?: string, message?: string, times?: number}} [opts.searchReject]
 *   make the top-k query reject N times (default: always) with this pg
 *   error (default message: "different vector dimensions 1536 and 768")
 */
function fakePool(opts = {}) {
  const queries = [];
  let probeCalls = 0;
  let searchRejectsLeft = opts.searchReject ? (opts.searchReject.times ?? Infinity) : 0;
  const client = {
    released: 0,
    async query(text, params) {
      queries.push({ text, params });
      if (/length\(vector::text\)/.test(text)) {
        probeCalls++;
        if (opts.dimReject) return { rows: [] };
        const seq = opts.dimSequence;
        const dim = seq ? seq[Math.min(probeCalls - 1, seq.length - 1)] : 1536;
        return { rows: [{ collection_name: params[0], dim }] };
      }
      if (/pg_attribute/.test(text)) {
        // catalog typmod fallback (empty-collection path only)
        if (opts.catalogReject) return { rows: [{ dim: -1 }] };
        return { rows: [{ dim: opts.catalogDim ?? 1532 }] };
      }
      if (/SET default_transaction_read_only/.test(text)) return { rows: [] };
      if (searchRejectsLeft > 0) {
        searchRejectsLeft--;
        const err = new Error(opts.searchReject.message ?? "different vector dimensions 1536 and 768");
        if (opts.searchReject.code !== undefined) err.code = opts.searchReject.code;
        throw err;
      }
      return { rows: opts.rows ?? [] };
    },
    release() { this.released++; },
  };
  const pool = {
    queries,
    client,
    connects: 0,
    ends: 0,
    dimProbeCount: () => pool.queries.filter((q) => /length\(vector::text\)/.test(q.text)).length,
    async connect() {
      pool.connects++;
      if (opts.rejectConnect) throw new Error("password authentication failed for user kb_readonly");
      return client;
    },
    async end() { pool.ends++; },
  };
  return pool;
}

const PG_CONFIG = {
  pgUrlRef: "PG_URL",
  pgTableName: "document_chunk",
  embeddingUrl: "https://gw.test/v1",
  embeddingModel: "bce-embedding-base_v1",
  embeddingKeyRef: "",
  embeddingDim: 0,
  k: 8,
  timeoutMs: 15000,
  kbListOverride: [{ id: "kb-a", name: "KB A" }],
};

test("pgvector: search SQL shape (m0-probe form), params [literal, kbId, k], read-only SET, row mapping", async () => {
  // Spec 修正 5 case (a): the catalog typmod says 1532 (fakePool default
  // catalogDim) while the sample row is 1536 — the top-k literal MUST use
  // the stored row dim: 1536 elements (1535 commas).
  const pool = fakePool({
    rows: [{ id: "r1", collection_name: "kb-a", text: "chunk text", vmetadata: { title: "T", page: 3 }, dist: 0.4 }],
    catalogDim: 1532,
  });
  const backend = createPgvectorBackend({
    config: PG_CONFIG,
    resolveCredential: async (ref) => (ref === "PG_URL" ? { value: "postgres://kb_readonly:fakepw@db.example:5432/powergpt" } : undefined),
    poolFactory: async () => pool,
    fetchImpl: embedFetchOk(Array.from({ length: 768 }, () => 0.25)),
  });
  const rows = await backend.search({ kbId: "kb-a", query: "q", k: 4, allowedIds: new Set(["kb-a"]) });
  assert.deepEqual(rows, [{ id: "r1", collectionName: "kb-a", text: "chunk text", vmetadata: { title: "T", page: 3 }, dist: 0.4 }]);
  const select = pool.queries.find((q) => q.text.startsWith("SELECT id,"));
  assert.ok(select, "the top-k SELECT was issued");
  assert.match(
    select.text,
    /FROM document_chunk WHERE collection_name = \$2 ORDER BY vector <=> \$1::vector LIMIT \$3/
  );
  assert.equal(select.params[1], "kb-a");
  assert.equal(select.params[2], 4);
  const literal = select.params[0];
  assert.ok(literal.startsWith("[") && literal.endsWith("]"), "pgvector 0.8.x bracket literal (not the PG array form)");
  assert.equal(literal.split(",").length, 1536, "zero-padded 768 → 1536 (1535 commas: the probed STORED dim, not the stale typmod 1532)");
  // stored-dim probe: the spec SQL shape (sample row, LIMIT 1), parameterized by collection
  const dimProbe = pool.queries.find((q) => /length\(vector::text\)/.test(q.text));
  assert.ok(dimProbe, "the stored-dim probe ran (embeddingDim = 0)");
  assert.match(dimProbe.text, /length\(vector::text\) - length\(replace\(vector::text, ',', ''\)\) \+ 1 AS dim FROM document_chunk WHERE collection_name = \$1 LIMIT 1/);
  assert.equal(dimProbe.params[0], "kb-a", "the probe targets the searched collection");
  assert.equal(pool.queries.filter((q) => /pg_attribute/.test(q.text)).length, 0, "no catalog fallback when a sample row exists");
  const setIdx = pool.queries.findIndex((q) => q.text.includes("SET default_transaction_read_only"));
  const selectIdx = pool.queries.findIndex((q) => q.text.startsWith("SELECT id,"));
  assert.ok(setIdx !== -1 && setIdx < selectIdx, "SET read-only precedes the SELECT");
  await backend.close();
  assert.equal(pool.ends, 1, "close() ends the pool");
});

test("pgvector: stored dim is probed once per collection (cached across searches, keyed by collection)", async () => {
  const pool = fakePool({ rows: [] });
  const backend = createPgvectorBackend({
    config: { ...PG_CONFIG, kbListOverride: [{ id: "kb-a", name: "A" }, { id: "kb-b", name: "B" }] },
    resolveCredential: async () => ({ value: "postgres://u:fakepw@db.example/db" }),
    poolFactory: async () => pool,
    fetchImpl: embedFetchOk(Array.from({ length: 1536 }, () => 0.1)),
  });
  const allowed = new Set(["kb-a", "kb-b"]);
  await backend.search({ kbId: "kb-a", query: "q1", k: 2, allowedIds: allowed });
  await backend.search({ kbId: "kb-a", query: "q2", k: 2, allowedIds: allowed });
  assert.equal(pool.dimProbeCount(), 1, "kb-a probed once, then cached");
  await backend.search({ kbId: "kb-b", query: "q3", k: 2, allowedIds: allowed });
  assert.equal(pool.dimProbeCount(), 2, "kb-b probed on first use");
  const probes = pool.queries.filter((q) => /length\(vector::text\)/.test(q.text));
  assert.equal(probes[0].params[0], "kb-a");
  assert.equal(probes[1].params[0], "kb-b");
  await backend.close();
});

test("pgvector: embeddingDim > 0 explicit fix wins (skips both probes)", async () => {
  // Spec 修正 5 case (b): an explicit embeddingDim: 1532 beats the sample
  // row — the literal has exactly 1532 elements (1531 commas).
  const pool = fakePool({ rows: [] });
  const backend = createPgvectorBackend({
    config: { ...PG_CONFIG, embeddingDim: 1532 },
    resolveCredential: async () => ({ value: "postgres://u:fakepw@db.example/db" }),
    poolFactory: async () => pool,
    fetchImpl: embedFetchOk(Array.from({ length: 768 }, () => 0.1)),
  });
  await backend.search({ kbId: "kb-a", query: "q", k: 2, allowedIds: new Set(["kb-a"]) });
  assert.equal(pool.dimProbeCount(), 0, "no sample-row probe");
  assert.equal(pool.queries.filter((q) => /pg_attribute/.test(q.text)).length, 0, "no catalog probe");
  const select = pool.queries.find((q) => q.text.startsWith("SELECT id,"));
  assert.equal(select.params[0].split(",").length, 1532, "zero-padded to exactly the configured dim (1531 commas)");
  await backend.close();
});

test("pgvector: dimension mismatch (22000) → stored dim re-probed once, retrieval retried once", async () => {
  // First attempt fails with 22000 (the reindex changed 1536 → 1532);
  // the re-probe returns the NEW dim and the retry uses it.
  const pool = fakePool({
    rows: [{ id: "r1", collection_name: "kb-a", text: "ok after retry", vmetadata: null, dist: 0.2 }],
    dimSequence: [1536, 1532],
    searchReject: { code: "22000", times: 1 },
  });
  const backend = createPgvectorBackend({
    config: PG_CONFIG,
    resolveCredential: async () => ({ value: "postgres://u:fakepw@db.example/db" }),
    poolFactory: async () => pool,
    fetchImpl: embedFetchOk(Array.from({ length: 768 }, () => 0.5)),
    log: { warn() {}, error() {} },
  });
  const rows = await backend.search({ kbId: "kb-a", query: "q", k: 2, allowedIds: new Set(["kb-a"]) });
  assert.equal(rows.length, 1, "the retry succeeded");
  assert.equal(rows[0].text, "ok after retry");
  assert.equal(pool.dimProbeCount(), 2, "probed initially + re-probed after the mismatch");
  const selects = pool.queries.filter((q) => q.text.startsWith("SELECT id,"));
  assert.equal(selects.length, 2, "the query ran exactly twice");
  assert.equal(selects[0].params[0].split(",").length, 1536, "first attempt used the cached (stale) dim");
  assert.equal(selects[1].params[0].split(",").length, 1532, "the retry used the re-probed dim");
  await backend.close();
});

test("pgvector: dimension mismatch persisting after the retry → pg-dim-mismatch", async () => {
  const pool = fakePool({
    dimSequence: [1536, 1536],
    searchReject: { code: "22000" }, // always
  });
  const backend = createPgvectorBackend({
    config: PG_CONFIG,
    resolveCredential: async () => ({ value: "postgres://u:fakepw@db.example/db" }),
    poolFactory: async () => pool,
    fetchImpl: embedFetchOk(Array.from({ length: 768 }, () => 0.5)),
    log: { warn() {}, error() {} },
  });
  await assert.rejects(
    () => backend.search({ kbId: "kb-a", query: "q", k: 2, allowedIds: new Set(["kb-a"]) }),
    (err) => err.code === "pg-dim-mismatch"
  );
  const selects = pool.queries.filter((q) => q.text.startsWith("SELECT id,"));
  assert.equal(selects.length, 2, "initial attempt + exactly one retry");
  assert.equal(pool.dimProbeCount(), 2, "initial probe + one re-probe");
  await backend.close();
});

test("pgvector: empty collection (no sample row) → catalog typmod fallback, no error", async () => {
  // Spec 修正 5 case (c): sample-row probe returns nothing (empty
  // collection) → fall back to the catalog typmod dim (1532) — harmless,
  // a top-k over an empty collection never evaluates `<=>`.
  const pool = fakePool({ dimReject: true, catalogDim: 1532, rows: [] });
  const backend = createPgvectorBackend({
    config: PG_CONFIG,
    resolveCredential: async () => ({ value: "postgres://u:fakepw@db.example/db" }),
    poolFactory: async () => pool,
    fetchImpl: embedFetchOk(Array.from({ length: 768 }, () => 0.5)),
  });
  const rows = await backend.search({ kbId: "kb-a", query: "q", k: 2, allowedIds: new Set(["kb-a"]) });
  assert.deepEqual(rows, [], "empty collection → empty result, no error");
  const select = pool.queries.find((q) => q.text.startsWith("SELECT id,"));
  assert.equal(select.params[0].split(",").length, 1532, "the fallback literal uses the catalog typmod dim");
  assert.equal(pool.queries.filter((q) => /pg_attribute/.test(q.text)).length, 1, "the catalog fallback ran once");
  await backend.close();
});

test("pgvector: no sample row AND no usable catalog typmod → pg-error, no top-k", async () => {
  const pool = fakePool({ dimReject: true, catalogReject: true });
  const backend = createPgvectorBackend({
    config: PG_CONFIG,
    resolveCredential: async () => ({ value: "postgres://u:fakepw@db.example/db" }),
    poolFactory: async () => pool,
    fetchImpl: embedFetchOk(Array.from({ length: 768 }, () => 0.5)),
  });
  await assert.rejects(
    () => backend.search({ kbId: "kb-a", query: "q", k: 2, allowedIds: new Set(["kb-a"]) }),
    (err) => {
      assert.equal(err.code, "pg-error");
      assert.ok(!err.message.includes("fakepw"), "no credential leak");
      return true;
    }
  );
  const selects = pool.queries.filter((q) => q.text.startsWith("SELECT id,"));
  assert.equal(selects.length, 0, "no top-k query was issued");
  await backend.close();
});

test("pgvector: mismatch detected by MESSAGE (no SQLSTATE) → re-probe once + retry once", async () => {
  // Spec 修正 5: the 22000 path also triggers when err.code is absent but
  // the message matches /different vector dimensions/i.
  const pool = fakePool({
    rows: [{ id: "r1", collection_name: "kb-a", text: "ok after retry", vmetadata: null, dist: 0.2 }],
    dimSequence: [1536, 1536],
    catalogDim: 1532,
    searchReject: { message: "invalid input syntax for vector: different vector dimensions 1536 and 768", times: 1 },
  });
  const backend = createPgvectorBackend({
    config: PG_CONFIG,
    resolveCredential: async () => ({ value: "postgres://u:fakepw@db.example/db" }),
    poolFactory: async () => pool,
    fetchImpl: embedFetchOk(Array.from({ length: 768 }, () => 0.5)),
    log: { warn() {}, error() {} },
  });
  const rows = await backend.search({ kbId: "kb-a", query: "q", k: 2, allowedIds: new Set(["kb-a"]) });
  assert.equal(rows.length, 1, "the message-matched retry succeeded");
  assert.equal(pool.dimProbeCount(), 2, "probed initially + re-probed after the mismatch");
  const selects = pool.queries.filter((q) => q.text.startsWith("SELECT id,"));
  assert.equal(selects.length, 2, "the query ran exactly twice");
  await backend.close();
});

test("pgvector: kbId outside allowedIds → kb-not-whitelisted, no connection, no embed", async () => {
  let built = 0;
  let embedCalls = 0;
  const backend = createPgvectorBackend({
    config: PG_CONFIG,
    resolveCredential: async () => ({ value: "postgres://u:fakepw@db.example/db" }),
    poolFactory: async () => { built++; return fakePool(); },
    fetchImpl: (url) => { embedCalls++; return embedFetchOk([0.1])(url); },
  });
  await assert.rejects(
    () => backend.search({ kbId: "kb-evil", query: "q", k: 4, allowedIds: new Set(["kb-a"]) }),
    (err) => err.code === "kb-not-whitelisted"
  );
  assert.equal(built, 0, "no pool built");
  assert.equal(embedCalls, 0, "no outbound embed call");
});

test("pgvector: connect failure → one pool rebuild, then pg-unreachable", async () => {
  let built = 0;
  const backend = createPgvectorBackend({
    config: PG_CONFIG,
    resolveCredential: async () => ({ value: "postgres://u:fakepw@db.example/db" }),
    poolFactory: async () => { built++; return fakePool({ rejectConnect: true }); },
    fetchImpl: embedFetchOk(Array.from({ length: 768 }, () => 0)),
    log: { warn() {}, error() {} },
  });
  await assert.rejects(
    () => backend.search({ kbId: "kb-a", query: "q", k: 4, allowedIds: new Set(["kb-a"]) }),
    (err) => {
      assert.equal(err.code, "pg-unreachable");
      assert.ok(!err.message.includes("fakepw"), "the DSN password never leaks into the message");
      return true;
    }
  );
  assert.equal(built, 2, "initial pool + exactly one rebuild");
  await backend.close();
});

test("pgvector: embed 401 → embed-error:401 passes through, no pool connection", async () => {
  const pool = fakePool();
  const backend = createPgvectorBackend({
    config: PG_CONFIG,
    resolveCredential: async () => ({ value: "postgres://u:fakepw@db.example/db" }),
    poolFactory: async () => pool,
    fetchImpl: () => Promise.resolve({ ok: false, status: 401, text: async () => "denied" }),
  });
  await assert.rejects(
    () => backend.search({ kbId: "kb-a", query: "q", k: 4, allowedIds: new Set(["kb-a"]) }),
    (err) => err.code === "embed-error:401"
  );
  assert.equal(pool.connects, 0, "no pool connection for a failed embed");
});

test("pgvector: empty kbListOverride → pgvector-no-whitelist at construction", () => {
  assert.throws(
    () =>
      createPgvectorBackend({
        config: { ...PG_CONFIG, kbListOverride: [] },
        resolveCredential: async () => undefined,
      }),
    (err) => err.code === "pgvector-no-whitelist"
  );
});

test("pgvector: unsafe pgTableName → pg-bad-config at construction", () => {
  assert.throws(
    () =>
      createPgvectorBackend({
        config: { ...PG_CONFIG, pgTableName: "document_chunk; DROP TABLE x" },
        resolveCredential: async () => undefined,
      }),
    (err) => err.code === "pg-bad-config"
  );
});

test("pgvector: missing DSN credential → pg-not-configured (default factory, no pg import)", async () => {
  const backend = createPgvectorBackend({
    config: PG_CONFIG,
    resolveCredential: async () => undefined, // credentials service has no value
    fetchImpl: embedFetchOk(Array.from({ length: 768 }, () => 0.5)),
    log: { warn() {}, error() {} },
  });
  await assert.rejects(
    () => backend.search({ kbId: "kb-a", query: "q", k: 4, allowedIds: new Set(["kb-a"]) }),
    (err) => err.code === "pg-not-configured"
  );
});

test("pgvector: retrieve → canonical chunks (probe-faithful source coalesce, dist→score honesty)", async () => {
  const pool = fakePool({
    rows: [
      { id: "r1", collection_name: "kb-a", text: "t1", vmetadata: { title: "Handbook", page: 12 }, dist: 0.4 },
      { id: "r2", collection_name: "kb-a", text: "t2", vmetadata: { file_id: "abc12345xyz", page_label: "7" }, dist: 1.8 },
    ],
  });
  const backend = createPgvectorBackend({
    config: PG_CONFIG,
    resolveCredential: async () => ({ value: "postgres://u:fakepw@db.example/db" }),
    poolFactory: async () => pool,
    fetchImpl: embedFetchOk(Array.from({ length: 768 }, () => 0.5)),
  });
  const chunks = await backend.retrieve("kb-a", "q", 5);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0], { text: "t1", source: "Handbook · p.12", score: 0.6 });
  assert.deepEqual(chunks[1], { text: "t2", source: "file abc12345 · p.7" });
  assert.ok(!("score" in chunks[1]), "out-of-range dist → score omitted, never relabeled");
  const select = pool.queries.find((q) => q.text.startsWith("SELECT id,"));
  assert.equal(select.params[0].split(",").length, 1536, "the 768-dim gateway vector was zero-padded to the stored dim");
  await backend.close();
});

// ── kb-list provider (M1b whitelist behavior) ──────────────────────────────

test("kb-list: non-empty override → static list, fetchList never called", async () => {
  let fetchCalls = 0;
  const provider = makeKbListProvider({
    overrideList: normalizeKbListOverride([
      { id: "kb-1", name: "One", description: "d" },
      { id: "kb-2", name: "Two" },
    ]),
    fetchList: async () => {
      fetchCalls++;
      return [];
    },
  });
  assert.equal(provider.source, "override");
  const list = await provider.list();
  assert.deepEqual(list, [
    { id: "kb-1", name: "One", description: "d" },
    { id: "kb-2", name: "Two" },
  ]);
  await provider.list();
  assert.equal(fetchCalls, 0, "zero network in override mode");
});

test("kb-list: empty override → OWUI fetch (regression) + cache + stale-on-failed-refresh", async () => {
  let fetchCalls = 0;
  let fail = false;
  const provider = makeKbListProvider({
    overrideList: [],
    fetchList: async () => {
      fetchCalls++;
      if (fail) throw Object.assign(new Error("owui-down"), { code: "owui-unreachable" });
      return [{ id: "kb-9", name: "Nine" }];
    },
    ttlMs: 30,
    log: { warn() {} },
  });
  assert.equal(provider.source, "owui");
  assert.deepEqual(await provider.list(), [{ id: "kb-9", name: "Nine" }]);
  await provider.list();
  assert.equal(fetchCalls, 1, "cached within the TTL");
  await new Promise((r) => setTimeout(r, 40)); // let the cache go stale
  fail = true;
  assert.deepEqual(await provider.list(), [{ id: "kb-9", name: "Nine" }], "stale list served on a failed refresh");
  assert.equal(fetchCalls, 2);
});

test("kb-list: empty override + nothing cached + fetch failure → the error propagates", async () => {
  const provider = makeKbListProvider({
    overrideList: [],
    fetchList: async () => {
      throw Object.assign(new Error("owui-down"), { code: "owui-unreachable" });
    },
  });
  await assert.rejects(() => provider.list(), (err) => err.code === "owui-unreachable");
});

test("kb-list: normalizeKbListOverride — drops malformed, dedupes, strips empty description", () => {
  const out = normalizeKbListOverride([
    { id: "a", name: "A", description: "" },
    { id: "a", name: "A-dup" },
    { id: "b", name: "" },
    { name: "no-id" },
    null,
    "junk",
    { id: "c", name: "C", description: "desc" },
  ]);
  assert.deepEqual(out, [
    { id: "a", name: "A" },
    { id: "c", name: "C", description: "desc" },
  ]);
  assert.deepEqual(normalizeKbListOverride(undefined), []);
});

// ── normalize: shapePgvectorRows (M1b) ─────────────────────────────────────

test("shapePgvectorRows: dist 0.4 → score 0.6 kept; dist 1.8 → score omitted", () => {
  const out = shapePgvectorRows([
    { id: "1", collectionName: "kb", text: "a", vmetadata: null, dist: 0.4 },
    { id: "2", collectionName: "kb", text: "b", vmetadata: null, dist: 1.8 },
    { id: "3", collectionName: "kb", text: "c", vmetadata: null, dist: -0.2 },
  ]);
  assert.deepEqual(out[0], { text: "a", score: 0.6 });
  assert.deepEqual(out[1], { text: "b" });
  assert.ok(!("score" in out[1]), "out-of-range dist (1.8) → no score, never fabricated");
  assert.ok(!("score" in out[2]), "negative dist → out of range → omitted");
});

test("shapePgvectorRows: vmetadata coalesce branches (title/name/source/file_id + page/page_label)", () => {
  const out = shapePgvectorRows([
    { text: "1", vmetadata: { title: "T", name: "N", source: "S", page: 3 }, dist: 0 },
    { text: "2", vmetadata: { name: "N", source: "S", page: "7" }, dist: 0.5 },
    { text: "3", vmetadata: { source: "S", page_label: "A2" }, dist: 0.5 },
    { text: "4", vmetadata: { file_id: "abc12345678" }, dist: 0.5 },
    { text: "5", vmetadata: { hash: "x" }, dist: 0.5 },
    { text: "6", vmetadata: null, dist: 0.5 },
    { text: "7", dist: 0.5 },
  ]);
  assert.equal(out[0].source, "T · p.3", "title wins; page appended");
  assert.equal(out[1].source, "N · p.7", "name fallback");
  assert.equal(out[2].source, "S · p.A2", "source fallback; page_label fallback");
  assert.equal(out[3].source, "file abc12345", "file_id → first 8 chars");
  assert.ok(!("source" in out[4]), "no usable metadata → source omitted");
  assert.ok(!("source" in out[5]), "null vmetadata → source omitted");
  assert.ok(!("source" in out[6]), "missing vmetadata → source omitted");
});

test("shapePgvectorRows: feeds the existing shapeResults (k/cut/budget logic reused)", () => {
  const rows = [
    { text: "x".repeat(2000), vmetadata: { title: "T" }, dist: 0.3 },
    { text: "y".repeat(50), vmetadata: null, dist: 0.3 },
  ];
  const shaped = shapeResults(shapePgvectorRows(rows), { k: 8, maxChunkChars: 100, budget: 120 });
  assert.equal(shaped.truncated, true);
  assert.equal(shaped.results[0].text.length, 100, "per-chunk cut");
  assert.equal(shaped.results[0].score, 0.7);
  assert.equal(shaped.results[1].text.length, 20, "budget tail cut");
});

// ── settings (runtime-override logic, pure) ────────────────────────────────

test("settings: validateSettingsBody accepts the whitelisted keys", () => {
  assert.deepEqual(validateSettingsBody({}), { ok: true });
  assert.deepEqual(validateSettingsBody({ backend: "pgvector" }), { ok: true });
  assert.deepEqual(validateSettingsBody({ backend: "owui" }), { ok: true });
  assert.deepEqual(validateSettingsBody({ rerankEnabled: false }), { ok: true });
  assert.deepEqual(validateSettingsBody({ k: 1 }), { ok: true });
  assert.deepEqual(validateSettingsBody({ k: 20 }), { ok: true });
  assert.deepEqual(validateSettingsBody({ reset: true }), { ok: true });
  assert.deepEqual(validateSettingsBody({ backend: "owui", rerankEnabled: true, k: 12 }), { ok: true });
});

test("settings: validateSettingsBody refuses unknown keys and bad types", () => {
  for (const body of [
    { pgUrlRef: "X" }, // a credential ref is never overridable
    { kbListOverride: [] }, // the whitelist is the security boundary
    { embeddingUrl: "http://x" },
    { backend: "sqlite" },
    { rerankEnabled: "on" },
    { k: 0 },
    { k: 21 },
    { k: 2.5 },
    { k: "5" },
    { reset: "yes" },
    "not-an-object",
    null,
    [1, 2],
  ]) {
    assert.equal(validateSettingsBody(body).ok, false, JSON.stringify(body));
  }
});

test("settings: applySettingsBody sets, merges, and resets", () => {
  const overrides = {};
  applySettingsBody(overrides, { backend: "owui" });
  assert.equal(overrides.backend, "owui");
  applySettingsBody(overrides, { k: 12 });
  assert.deepEqual(overrides, { backend: "owui", k: 12 }, "merge, not replace");
  applySettingsBody(overrides, { reset: true });
  assert.deepEqual(overrides, {}, "reset clears everything");
  const eff = { backend: "pgvector", k: 8, rerankEnabled: true };
  assert.deepEqual({ ...eff, ...overrides }, eff, "eff() = config + overrides");
});

// ── pgvector probe (the settings /settings/test seam) ─────────────────────

test("pgvector: probe() answers {ok, ms} via SELECT 1", async () => {
  const pool = fakePool();
  const backend = createPgvectorBackend({
    config: PG_CONFIG,
    resolveCredential: async () => ({ value: "postgres://u:fakepw@db.example/db" }),
    poolFactory: async () => pool,
    fetchImpl: embedFetchOk(Array.from({ length: 768 }, () => 0.25)),
  });
  const r = await backend.probe();
  assert.equal(r.ok, true);
  assert.ok(typeof r.ms === "number" && r.ms >= 0);
  assert.ok(pool.queries.find((q) => q.text === "SELECT 1"), "the probe issued SELECT 1");
  await backend.close();
});

test("pgvector: probe() surfaces a connect failure as pg-unreachable", async () => {
  const pool = fakePool({ rejectConnect: true });
  const backend = createPgvectorBackend({
    config: PG_CONFIG,
    resolveCredential: async () => ({ value: "postgres://u:fakepw@db.example/db" }),
    poolFactory: async () => pool,
    fetchImpl: embedFetchOk(Array.from({ length: 768 }, () => 0.25)),
  });
  const err = await backend.probe().then(
    () => null,
    (e) => e
  );
  assert.equal(err.code, "pg-unreachable");
  await backend.close();
});

test("pgvector: probe() without the DSN credential → pg-not-configured (default factory path)", async () => {
  // No poolFactory: the DEFAULT factory runs dsn() (credential check)
  // BEFORE the lazy pg import, so this is safe in a pg-less environment.
  const backend = createPgvectorBackend({
    config: PG_CONFIG,
    resolveCredential: async () => undefined,
  });
  const err = await backend.probe().then(
    () => null,
    (e) => e
  );
  assert.equal(err.code, "pg-not-configured");
});

// ── kb-tool: dynamic k cap (settings runtime override) ─────────────────────

test("kb-tool: limits.k may be a () => number read per call", async () => {
  const calls = [];
  const backend = {
    retrieve: async (kbId, query, k) => {
      calls.push(k);
      return [{ text: "t", source: "s", score: 0.9 }];
    },
  };
  const state = { get: () => ({ id: "kb-a", name: "A" }) };
  let kNow = 8;
  const tool = makeKbSearchTool({
    backend,
    state,
    limits: { k: () => kNow, maxChunkChars: 1200, budget: 6000 },
  });
  await tool.execute({ query: "q" }, { agent: { session: { id: "s1" } } });
  assert.equal(calls[0], 8);
  kNow = 3;
  await tool.execute({ query: "q" }, { agent: { session: { id: "s1" } } });
  assert.equal(calls[1], 3, "the per-call cap follows the override");
});
