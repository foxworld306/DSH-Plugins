/**
 * 闆堕厤缃?+ 涓汉鐭ヨ瘑搴撴敼閫犵殑鏈満 smoke锛堜笉渚濊禆 DSH銆佷笉杩炵湡搴擄級銆? * 鐢ㄦ硶锛?node test/local-smoke.mjs
 */
import assert from "node:assert/strict";
import { makeIdentityResolver, IDENTITY_SOURCES, looksLikeEmail } from "../lib/identity.js";
import { makeIdentityKbListProvider } from "../lib/kb-list.js";
import { createPgvectorBackend } from "../lib/pgvector.js";

const publicList = [
  { id: "85a173a4-af87-4a70-b91a-a3bf9e3bda59", name: "SUEZ Knowledge" },
  { id: "71dfcd55-6f09-4c39-a698-e29eaf398b1a", name: "Water Treatment Documents" },
];
const baseConfig = {
  kbListOverride: publicList,
  pgTableName: "document_chunk",
  pgUrl: "",
  pgUrlRef: "OWUI_PG_READONLY_URL",
  embeddingUrl: "https://gateway.example/v1",
  embeddingModel: "bce-embedding-base_v1",
  embeddingKeyRef: "",
  embeddingDim: 3,
  k: 8,
  timeoutMs: 5000,
  rerankApiKey: "",
};

let pass = 0;
const t = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    pass += 1;
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err?.message ?? err}`);
    process.exitCode = 1;
  }
};

// 1) identity precedence
await t("identity: env beats config and registry", async () => {
  const r = makeIdentityResolver({
    config: { identityEmail: "cfg@corp.com" },
    env: { SUEZ_USER_EMAIL: "env@corp.com" },
    read: () => "reg@corp.com",
  });
  assert.deepEqual(await r.resolve(), { email: "env@corp.com", source: IDENTITY_SOURCES.ENV });
});

await t("identity: config when env absent", async () => {
  const r = makeIdentityResolver({ config: { identityEmail: "cfg@corp.com" }, env: {}, read: () => "reg@corp.com" });
  assert.deepEqual(await r.resolve(), { email: "cfg@corp.com", source: IDENTITY_SOURCES.CONFIG });
});

await t("identity: OneDrive registry fallback", async () => {
  const r = makeIdentityResolver({
    config: {},
    env: {},
    read: (key) => (key.includes("OneDrive") ? "rio.zhao@suez.com" : undefined),
  });
  assert.deepEqual(await r.resolve(), { email: "rio.zhao@suez.com", source: IDENTITY_SOURCES.ONEDRIVE });
});

await t("identity: Office ADUserName last resort", async () => {
  const r = makeIdentityResolver({
    config: {},
    env: {},
    read: (key) => (key.includes("Office") ? "riozhao@suez-asia.local" : undefined),
  });
  assert.deepEqual(await r.resolve(), { email: "riozhao@suez-asia.local", source: IDENTITY_SOURCES.OFFICE });
});

await t("identity: all missing -> unresolved and cached", async () => {
  let reads = 0;
  const r = makeIdentityResolver({ config: {}, env: {}, read: () => (reads++, undefined) });
  assert.deepEqual(await r.resolve(), { email: undefined, source: IDENTITY_SOURCES.UNRESOLVED });
  const first = reads;
  await r.resolve();
  assert.equal(reads, first, "second call must hit the cache");
});

await t("identity: looksLikeEmail rejects paths and blanks", () => {
  assert.equal(looksLikeEmail("a@b.com"), true);
  assert.equal(looksLikeEmail("C:\\x\\y"), false);
  assert.equal(looksLikeEmail(" a@b "), false);
  assert.equal(looksLikeEmail(undefined), false);
});

// 2) provider
await t("kb-list: identity list wins", async () => {
  const p = makeIdentityKbListProvider({
    fetchVisible: async () => [...publicList, { id: "kb-hrdb", name: "HRDB", source: "personal" }],
    fallbackList: publicList,
    ttlMs: 0,
  });
  const list = await p.list();
  assert.equal(list.length, 3);
  assert.equal(list[2].name, "HRDB");
  assert.equal(p.currentSource(), "identity");
});

await t("kb-list: failure degrades to static whitelist", async () => {
  const p = makeIdentityKbListProvider({
    fetchVisible: async () => {
      throw Object.assign(new Error("boom"), { code: "pg-acl-unavailable" });
    },
    fallbackList: publicList,
    ttlMs: 60000,
    log: { warn: () => {} },
  });
  const list = await p.list();
  assert.deepEqual(
    list.map((k) => k.id),
    publicList.map((k) => k.id)
  );
  assert.equal(p.currentSource(), "fallback");
});

// 3) fake pool
function fakePool(handler) {
  const queries = [];
  const client = {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      return handler(sql, params);
    },
    release() {},
  };
  return { pool: { connect: async () => client, end: async () => {} }, client };
}

const embedFetch = async () => ({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) });

// 4) DSN precedence
await t("pgvector: config.pgUrl wins (bad host -> pg-unreachable, not not-configured)", async () => {
  const backend = createPgvectorBackend({
    config: { ...baseConfig, pgUrl: "postgres://u:p@127.0.0.1:1/db", timeoutMs: 300 },
    resolveCredential: async () => {
      throw new Error("credential must not be read");
    },
    log: { warn: () => {}, error: () => {} },
  });
  await assert.rejects(backend.probe(), (err) => err.code === "pg-unreachable");
  await backend.close();
});

await t("pgvector: both empty -> pg-not-configured", async () => {
  const backend = createPgvectorBackend({
    config: { ...baseConfig, pgUrl: "" },
    resolveCredential: async () => undefined,
    log: { warn: () => {}, error: () => {} },
  });
  await assert.rejects(backend.probe(), (err) => err.code === "pg-not-configured");
});

// 5) listVisible
await t("pgvector: listVisible maps the DBA function rows", async () => {
  const { pool } = fakePool((sql) => {
    if (/kb_visible_kbs/.test(sql)) {
      return {
        rows: [
          { id: "85a173a4-af87-4a70-b91a-a3bf9e3bda59", name: "SUEZ Knowledge", description: "", write_access: false },
          { id: "kb-hrdb", name: "HRDB", description: "HR database", write_access: true },
        ],
      };
    }
    return { rows: [] };
  });
  const backend = createPgvectorBackend({
    config: baseConfig,
    resolveCredential: async () => ({ value: "postgres://u:p@h/db" }),
    poolFactory: async () => pool,
    log: { warn: () => {}, error: () => {} },
  });
  const list = await backend.listVisible("rio.zhao@suez.com");
  assert.equal(list.length, 2);
  assert.equal(list[0].source, "personal");
  assert.equal(list[0].description, undefined, "empty description must be dropped");
  assert.equal(list[1].writeAccess, true);
});

await t("pgvector: 42883 (no DBA function) falls back to the direct ACL query", async () => {
  let directQueried = false;
  const { pool } = fakePool((sql) => {
    if (/kb_visible_kbs/.test(sql)) throw Object.assign(new Error("function does not exist"), { code: "42883" });
    if (/FROM knowledge k/.test(sql)) {
      directQueried = true;
      return { rows: [{ id: "kb-hrdb", name: "HRDB", description: "", write_access: true, acl_source: "owner" }] };
    }
    return { rows: [] };
  });
  const backend = createPgvectorBackend({
    config: baseConfig,
    resolveCredential: async () => ({ value: "postgres://u:p@h/db" }),
    poolFactory: async () => pool,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const list = await backend.listVisible("rio.zhao@suez.com");
  assert.equal(directQueried, true, "direct ACL query must run");
  assert.equal(list.length, 1);
  assert.equal(list[0].acl, "owner");
});

await t("pgvector: ACL unresolvable (42501) -> pg-acl-unavailable", async () => {
  const { pool } = fakePool((sql) => {
    if (/kb_visible_kbs/.test(sql)) throw Object.assign(new Error("function does not exist"), { code: "42883" });
    throw Object.assign(new Error("permission denied for table knowledge"), { code: "42501" });
  });
  const backend = createPgvectorBackend({
    config: baseConfig,
    resolveCredential: async () => ({ value: "postgres://u:p@h/db" }),
    poolFactory: async () => pool,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  await assert.rejects(backend.listVisible("rio.zhao@suez.com"), (err) => err.code === "pg-acl-unavailable");
});

// 6) retrieval binds identity inside one transaction
await t("pgvector: retrieve with email -> BEGIN / SET LOCAL kb.email / COMMIT", async () => {
  const { pool, client } = fakePool((sql) => {
    if (/AS dim/.test(sql)) return { rows: [{ dim: 3 }] };
    if (sql.includes("<=>")) {
      return { rows: [{ id: "c1", collection_name: "kb-hrdb", text: "hello", vmetadata: { source: "a.pdf" }, dist: 0.2 }] };
    }
    return { rows: [] };
  });
  const backend = createPgvectorBackend({
    config: baseConfig,
    resolveCredential: async () => ({ value: "postgres://u:p@h/db" }),
    poolFactory: async () => pool,
    fetchImpl: embedFetch,
    log: { warn: () => {}, error: () => {} },
  });
  const rows = await backend.retrieve("kb-hrdb", "q", 3, { allowedIds: ["kb-hrdb"], email: "rio.zhao@suez.com" });
  assert.equal(rows.length, 1);
  const sqls = client.queries.map((q) => q.sql);
  assert.ok(sqls.includes("BEGIN"), "transaction must be opened");
  const setLocal = client.queries.find((q) => /set_config\('kb\.email'/i.test(q.sql) || /SET LOCAL kb\.email/i.test(q.sql));
  assert.ok(setLocal, "kb.email must be set");
  assert.deepEqual(setLocal.params, ["rio.zhao@suez.com"]);
  assert.ok(sqls.includes("COMMIT"), "transaction must be committed");
  assert.ok(!sqls.includes("ROLLBACK"), "no rollback expected");
});

await t("pgvector: kbId outside the whitelist is rejected before any connection", async () => {
  let touched = false;
  const backend = createPgvectorBackend({
    config: baseConfig,
    resolveCredential: async () => ({ value: "postgres://u:p@h/db" }),
    poolFactory: async () => {
      touched = true;
      return fakePool(() => ({ rows: [] })).pool;
    },
    fetchImpl: embedFetch,
    log: { warn: () => {}, error: () => {} },
  });
  await assert.rejects(
    backend.retrieve("kb-not-mine", "q", 3, { allowedIds: ["kb-hrdb"], email: "x@y.com" }),
    (err) => err.code === "kb-not-whitelisted"
  );
  assert.equal(touched, false, "no connection should be opened");
});

await t("pgvector: policy rerankApiKey also authenticates the embedding leg", async () => {
  const seen = [];
  const captureFetch = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.authorization });
    return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) };
  };
  const { pool } = fakePool((sql) => {
    if (/AS dim/.test(sql)) return { rows: [{ dim: 3 }] };
    if (sql.includes("<=>")) return { rows: [] };
    return { rows: [] };
  });
  const backend = createPgvectorBackend({
    config: { ...baseConfig, rerankApiKey: "sk-gateway-key" },
    resolveCredential: async () => undefined,
    poolFactory: async () => pool,
    fetchImpl: captureFetch,
    log: { warn: () => {}, error: () => {} },
  });
  await backend.retrieve("85a173a4-af87-4a70-b91a-a3bf9e3bda59", "q", 3, {
    allowedIds: ["85a173a4-af87-4a70-b91a-a3bf9e3bda59"],
    email: "rio.zhao@suez.com",
  });
  const embedCall = seen.find((s) => /embeddings/.test(s.url));
  assert.ok(embedCall, "embedding call must happen");
  assert.equal(embedCall.auth, "Bearer sk-gateway-key", "embedding must carry the policy key");
});

console.log(`\n${pass} passed${process.exitCode ? " (with failures)" : ""}`);
