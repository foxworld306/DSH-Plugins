# dsh-kb-query

Company knowledge-base (RAG) access for a dsh web profile — two halves:

- **Host** (`index.js` + `lib/`): registers the `kb_search` model tool (the
  agent retrieves the session's active KB and answers grounded in the
  chunks; results enter the turn as a tool result and never touch the
  prompt draft) and serves three same-origin, trust-fenced routes for the
  composer chip:

  | Route | Method | Body | Response |
  |---|---|---|---|
  | `/kb` | GET | — | `[{id, name, description?}]` (static override, else 30 s cache) |
  | `/kb/select` | POST | `{sessionId, kbId\|null}` | `{ok:true}` |
  | `/kb/query` | POST | `{kbId, query, k?}` | `{results:[{text, source?, score?}], truncated, degraded?, reason?}` (preview only; `degraded` present when the rerank stage fell back to the cosine order) |

- **Browser** (`client.js`): a “知识库” chip in the composer tool row
  (`conversation.input.left`, beside the Workspace Write chip) — pick a KB,
  preview a retrieval (pure display, no draft insertion), or turn it off.
  All traffic is same-origin `/kb*`; the browser never sees the OWUI URL,
  the PG DSN, or any key.

**Backends (M1b).** `backend: pgvector` (the default) reads the OWUI-owned
`document_chunk` table directly: embed the query (OpenAI-compatible
gateway), zero-pad the 768-dim vector to the collection's STORED row
dimension (1536, probed from a stored row — the column typmod says 1532
but that is stale metadata; OWUI itself retrieves against the stored
dimension), then one parameterized cosine top-k SQL — the exact shape
verified in production by `m0/probe-pgvector-e2e.mjs`. If a reindex changes
the stored dim while the cache is warm (SQLSTATE 22000), the dim is
re-probed once and the retrieval retried once; a persistent mismatch
answers `pg-dim-mismatch`. `backend: owui` (Open WebUI retrieval API) is
implemented and untouched — note that OWUI **0.8.12's** retrieval endpoint
answers 400 upstream (issue #14432); it is usable again once OWUI ≥ 0.9.5
is deployed.

**KB whitelist (M1b).** The static `kbListOverride` list is the SINGLE
source of truth for both backends: the `/kb` list, the `/kb/select` +
`/kb/query` whitelists, and the pgvector app-level whitelist. A non-empty
list means zero network; the OWUI knowledge API (30 s cache) is only the
empty-override fallback (phase 2). v1 scope = the two public KBs:
SUEZ Knowledge `85a173a4-af87-4a70-b91a-a3bf9e3bda59` and Water Treatment
Documents `71dfcd55-6f09-4c39-a698-e29eaf398b1a`.

**Rerank (M1b.5).** Both backends share the final-selection pipeline:
collect `fetchK` (default 20) candidates in cosine order → cross-encoder
rerank (`bge-reranker-v2-m3` at the same gateway, same `KB_EMBED_API_KEY`
Bearer key as the embeddings — contract production-verified by
`m0/probe-rerank.mjs`) → return `min(k, topKReranker)` chunks (default 5).
Triggered only when `rerankEnabled` (default true) AND the
`KB_EMBED_API_KEY` credential resolves AND at least one candidate exists.
ANY rerank failure (non-200, 5 s timeout, bad JSON, missing `results`,
out-of-range index) degrades to the pure cosine top-k and annotates the
result with `degraded: "rerank-unavailable"` + a short reason — a broken
reranker never fails the retrieval itself.

Design & mechanism facts: `docs/kb-query-plugin-plan.md` (this repo).

## Prerequisites (pgvector backend)

1. **DBA first**: run `m0/kb_readonly.sql` against the OWUI database
   (UUIDs already backfilled) — it creates the `kb_readonly` role
   (SELECT-only on `document_chunk`) plus an RLS policy limiting that role
   to the two public KB UUIDs. The plugin's DSN credential uses this role.
2. **Credentials**: put the values in dsh-credentials
   (`$DSH_HOME/.credentials.yaml` or `dsh` credential settings) — **never**
   in a config value or this repo:
   - `OWUI_PG_READONLY_URL` — the FULL DSN
     `postgres://kb_readonly:…@host:5432/powergpt`;
   - `OWUI_EMBEDDING_API_KEY` (or the reference you configure via
     `embeddingKeyRef`) — the embedding gateway key; leave
     `embeddingKeyRef: ""` for a keyless intranet gateway;
    - `KB_EMBED_API_KEY` — the shared embedding-gateway key used by the
      rerank stage (`/v1/rerank`, same gateway). Absent → the rerank stage
      is simply not triggered (pure cosine top-k, no `degraded` flag).
3. **E2E quality gate**: `m0/probe-pgvector-e2e.mjs` (same window as the
   M0 probes) is the retrieval-quality baseline — run it before and after
   deployment and compare top-k relevance; it executes the same SQL shape
   `lib/pgvector.js` ships.

## Install

```powershell
dsh plugin --profile web add C:\path\to\trust-header-sso-dsh\dsh-kb-query
```

Then restart `dsh web` (host-half changes do not HMR). Configure the
deployment values in the profile's own `cordis.patch.yml` (an override
replaces the row's whole config — restate every key, see
`cordis.patch.yml` here for the full default set):

```yaml
- id: kb-query
  config:
    backend: pgvector
    enabled: true
    openwebuiUrl: ""            # only needed for the owui backend / empty override
    apiKeyRef: OPENWEBUI_API_KEY
    pgUrlRef: OWUI_PG_READONLY_URL
    pgTableName: document_chunk
    embeddingUrl: "https://api-gateway.suezasia.com/v1"
    embeddingModel: bce-embedding-base_v1
    embeddingKeyRef: OWUI_EMBEDDING_API_KEY   # "" = keyless intranet gateway
    embeddingDim: 0               # 0 = probe the stored-row dim at runtime (typmod is stale metadata)
    k: 8
    maxChunkChars: 1200
    contextBudget: 6000
    trustedHosts: []              # e.g. [dsh.your-company.com]
    kbListOverride:
      - id: 85a173a4-af87-4a70-b91a-a3bf9e3bda59
        name: "SUEZ Knowledge"
        description: "公司内部知识库（SUEZ Knowledge，约 1,671 chunks）"
      - id: 71dfcd55-6f09-4c39-a698-e29eaf398b1a
        name: "Water Treatment Documents"
        description: "水处理技术文档库（Water Treatment Documents，约 12,996 chunks）"
    routePrefix: /kb
    timeoutMs: 15000
    rerankEnabled: true
    rerankUrl: "https://api-gateway.suezasia.com/v1/rerank"
    rerankModel: bge-reranker-v2-m3
    fetchK: 20
    topKReranker: 5
```

With the DSN missing, the pgvector retrieval answers 503
`pg-not-configured` (routes) / a structured `backend-error` (tool) — no
outbound connection — and boot never fails. Same doctrine for the OWUI key
(`owui-not-configured`) and the embedding gateway
(`embed-not-configured`).

### Config keys

| Key | Default | Meaning |
|---|---|---|
| `backend` | `pgvector` | `pgvector` (direct `document_chunk` read) or `owui` (Open WebUI retrieval API; broken upstream on OWUI 0.8.12 — issue #14432, OK on ≥ 0.9.5) |
| `enabled` | `true` | `false` registers nothing |
| `openwebuiUrl` | `""` | OWUI base URL (required for the owui backend and the empty-override KB list) |
| `apiKeyRef` | `OPENWEBUI_API_KEY` | dsh-credentials reference for the OWUI key/JWT |
| `pgUrlRef` | `OWUI_PG_READONLY_URL` | dsh-credentials reference holding the FULL read-only DSN (`postgres://kb_readonly:…@host:5432/powergpt`); resolved per pool build |
| `pgTableName` | `document_chunk` | OWUI vector table (legacy OWUI: `vector_search`); must be a safe SQL identifier |
| `embeddingUrl` | `""` | OpenAI-compatible embedding base INCLUDING `/v1` (pgvector backend) |
| `embeddingModel` | `""` | embedding model name (e.g. `bce-embedding-base_v1`) |
| `embeddingKeyRef` | `""` | dsh-credentials reference for the embedding key; `""` = keyless gateway |
| `embeddingDim` | `0` | vector dimension of the collection's STORED rows (pgvector); 0 = probe from a stored row at runtime (per collection, cached — the column typmod is stale metadata and is NOT consulted) — > 0 skips the probe and uses exactly this dim |
| `k` | `8` | per-call chunk cap (1–50) |
| `maxChunkChars` | `1200` | max characters per chunk text |
| `contextBudget` | `6000` | total tool-result budget (characters) |
| `trustedHosts` | `[]` | non-loopback Host authorities the fence accepts |
| `kbListOverride` | the two public KBs | static whitelist / KB list — source of truth for both backends; `description` may be omitted |
| `routePrefix` | `/kb` | prefix of the three routes |
| `timeoutMs` | `15000` | per-request timeout for outbound calls (OWUI / embeddings; also the PG `statement_timeout`) |
| `rerankEnabled` | `true` | trigger the cross-encoder rerank stage (requires the `KB_EMBED_API_KEY` credential; any rerank failure degrades to the cosine top-k with `degraded: "rerank-unavailable"`) |
| `rerankUrl` | `https://api-gateway.suezasia.com/v1/rerank` | rerank endpoint (same gateway as the embeddings) |
| `rerankModel` | `bge-reranker-v2-m3` | reranker model name |
| `fetchK` | `20` | candidates collected (cosine order) before rerank (10–50) |
| `topKReranker` | `5` | final chunk cap AFTER rerank (1–20); a retrieval returns `min(k, topKReranker)` chunks |

## Tests

```powershell
cd dsh-kb-query
node test/index.test.js
```

Pure-module unit tests only (fence / owui client with mocked
`globalThis.fetch` / embedding client + `zeroPad` + `toVectorLiteral` /
rerank stage `rerankChunks` + `selectFinal` with mocked fetch (normal /
non-200 degrade / out-of-range-index degrade / timeout / incomplete
scoring / trigger matrix / `min(k, topK)` clamp) / pgvector backend with a
fake pool / KB-list provider whitelist matrix /
normalize truncation-budget matrix incl. `shapePgvectorRows` / state /
`kb_search` execute incl. the `degraded` pass-through). `index.js` is
deliberately outside the test surface: its host dependencies resolve only
inside a dsh profile.

E2E smoke: start the web profile with the overlay
(`dsh web --patch dsh-kb-query/e2e-overlay.yml`, `embeddingUrl` /
`embeddingModel` pre-filled; the DSN + embedding key in dsh-credentials,
plus `KB_EMBED_API_KEY` to activate the rerank stage — without it the
smoke still passes, serving the cosine top-k) and probe the routes with a
browser-issued request (loopback Host):

```powershell
curl http://127.0.0.1:3080/kb
curl -X POST http://127.0.0.1:3080/kb/select -H "content-type: application/json" -d '{"sessionId":"demo","kbId":"85a173a4-af87-4a70-b91a-a3bf9e3bda59"}'
curl -X POST http://127.0.0.1:3080/kb/query -H "content-type: application/json" -d '{"kbId":"85a173a4-af87-4a70-b91a-a3bf9e3bda59","query":"SUEZ 的设备维护管理体系包含哪些核心内容与流程？","k":4}'
```

## Security boundary

- Secrets live host-side only (config references + dsh-credentials);
  `/kb*` responses and logs never carry a key/DSN; logs record sid/kbId/
  query **length**/result count/duration, never chunk content.
- `/kb*` is not under the `/api` fence, so every handler runs the trust
  fence (`lib/fence.js`, ported from `dsh-better-sidebar/src/trust-fence.ts`,
  behaviorally identical to the `/api` gateway fence): Host must be
  loopback or a `trustedHosts` entry, `sec-fetch-site: cross-site` refuses,
  a re-deciding Origin refuses.
- The trusted-header SSO gate (sibling plugin), when mounted, wraps every
  registered handler — these routes are gated automatically.
- `/kb/select` and `/kb/query` only accept a `kbId` that `listKbs()`
  currently serves (static override, else the OWUI knowledge list) —
  `kb-unknown` otherwise.
- pgvector defense in depth: (1) the app-level whitelist refuses any
  non-listed `kbId` with `kb-not-whitelisted` BEFORE any connection;
  (2) every search runs `SET default_transaction_read_only = on` on its
  pool client; (3) the DB role `kb_readonly` has SELECT-only grants plus an
  RLS policy limited to the two KB UUIDs (`m0/kb_readonly.sql`), so the row
  scope cannot be widened from the application at all.

## Error codes

Routes answer `503 {error: <code>}` for backend failures (code passthrough,
never a raw stack); the tool answers the closed JSON union
`ok` / `no-kb-selected` / `backend-error {code, message}`. Stable codes:
`owui-not-configured` / `owui-unreachable` / `owui-error:<status>` (owui
backend); `pg-not-configured` / `pg-unreachable` / `pg-error` /
`pg-dim-mismatch` / `kb-not-whitelisted` / `pgvector-no-whitelist` /
`pg-bad-config` (pgvector construction/query; `pg-dim-mismatch` = a 22000
dimension mismatch that persists after the one re-probe + retry);
`embed-not-configured` / `embed-unreachable` /
`embed-error:<status>` / `embed-shape` (embedding pipeline). Client errors:
`400 bad-request` / `kb-unknown`, `403 forbidden` (fence), `405
method-not-allowed`. A rerank failure is NOT an error: the response / tool
result stays 200/`ok` and carries `degraded: "rerank-unavailable"` + a
short reason instead.

## 与 OWUI 差异 (Differences vs OWUI, M1b.5 A/B evidence)

OWUI's actual retrieval (measured, M0 round 5): **Hybrid Search ON
(vector + BM25)** + external rerank `bge-reranker-v2-m3` at
`https://api-gateway.suezasia.com/v1/rerank`, Top 20 → 5. v1 mirrors the
rerank stage — pure-vector candidate collection (`fetchK` = 20, cosine
order) → the SAME reranker → `min(k, topKReranker)` = 5 — so the one
remaining retrieval difference is the missing **BM25 hybrid leg**:
candidates come from vector similarity only.

A/B evidence (weak bilingual case, "Ozone / UV disinfection"):
- **Before rerank** (cosine order): the top-5 is all SUEZ-KB-irrelevant
  VOCs content (cosine distances 0.53–0.56);
- **After rerank**: `SUEZ Water Handbook.md` returns to **#1**
  (relevance_score 0.0459 — about 10× the #2 score of 0.006);
- the correct document sat at candidate-pool position **7** — the
  `fetchK = 20` margin is sufficient headroom.

If a query ever lands outside the vector-similarity candidate pool
(BM25 would have caught it), raise `fetchK` toward 50 or switch the
backend to `owui` once OWUI ≥ 0.9.5 is deployed.

## Known limitations

- **Browser half not yet verified in a live GUI**: `client.js` follows the
  shipped `dsh-client-ui-jobs` ModuleLoader form, but the chip/dropdown/
  preview still need HMR + manual pass (plan M2).
- **`dsh.client.inject` minimal set is verified against the local dsh
  0.1.1-rc.2 install only** (locale + conversation entry; the slots service
  ships with the parser-preloaded `dsh-client-runtime`). Re-check when
  installing a different dsh version (plan M0 note).
- **The pg top-k query itself is not signal-cancellable** (pg 8.x has no
  query-level `AbortSignal`); the embedding and rerank steps observe the
  caller's cancellation signal (merged with their hard timeouts via
  `AbortSignal.any`), and the pool enforces `statement_timeout = timeoutMs`.
- **Vector input is the pgvector 0.8.x bracket literal** `[a,b,c]`
  (`vector_in` rejects the PostgreSQL array form with `22P02`, measured in
  production); `halfvec` uses the same bracket form. Zero-padding the
  768-dim gateway vector to the collection's stored row dimension (1536
  for both v1 collections) is cosine-invariant. The zero-pad target is
  probed from a stored row per collection (cached, sample-row `LIMIT 1`
  method): the column typmod (1532) is stale metadata — it is consulted
  only as the empty-collection fallback (harmless: a top-k over an empty
  collection never evaluates `<=>`); a 22000 "different vector dimensions"
  on a warm cache re-probes + retries once.
- **v1 retrieval is vector-only candidates + rerank — no BM25 hybrid leg**
  (OWUI runs Hybrid Search ON): see "与 OWUI 差异" above for the M1b.5
  A/B evidence and the `fetchK`/backend mitigations.
- **OWUI response field names are parsed defensively** (owui backend): KB
  `name` may be absent (falls back to the id); chunk text under
  `content|text`, metadata under `meta_data|metadata`, source under
  `source|file_name|filename`. Scores survive only inside 0..1 — a cosine
  distance is omitted rather than relabeled as a similarity (same policy
  for the pgvector `dist` → `1 - dist`).
- The session → KB map is host-process memory: a `dsh web` restart loses it
  until the chip re-arms the session (automatic on the next composer
  render).
