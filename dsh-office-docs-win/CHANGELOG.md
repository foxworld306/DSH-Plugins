# Changelog

All notable changes to `dsh-office-docs-win`. Versions follow semver; the DSH runtime range is
declared in `package.json` under `engines.dsh`.

## 1.0.1 — 2026-11-05

Publishing hygiene (no behavior change):
- Display metadata for the Plugins/Settings pages: `locale/en.json` + `locale/zh.json`
  (`meta.title`/`meta.description`) and the `suez-logo.png` icon (top-level `icon` field),
  wired through `exports["./locale/*.json"]` and `files`.
- `author` declared; `LICENSE` added to `files` explicitly (npm includes it either way).
- README: explicit "no configuration" note — the plugin intentionally declares no `Config`;
  render budgets are per-call tool parameters (e.g. `office_docs_render` `timeoutSec`).

## 1.0.0 — 2026-11-05

First version aligned with the published DSH plugin contract (`@deepseek-ai/dsh-package-manifest`
manifest v1, Cordis plugin shape, `@deepseek-ai/dsh-skill` provider protocol).

### What it ships
- `office-docs-win` skill: OOXML authored and edited as zip packages, plus rendering through
  Office COM. No Python, no pip, no LibreOffice, no admin rights.
- Three model tools: `office_docs_check` (package + XML + structure gate), `office_docs_dump`
  (pptx/docx/xlsx/pdf structure), `office_docs_render` (pptx → PNG, docx/xlsx → PDF).
- A JavaScript OOXML toolkit (`assets/office-docs-win/scripts/ooxml.mjs`, `dump.mjs`) that needs
  only `node:zlib`.

### Fixed before release
- **Excel PDF export produced an `.xlsm`**: `SaveAs($dest, 52)` is `xlOpenXMLWorkbookMacroEnabled`,
  not PDF. Now `ExportAsFixedFormat(0, $dest)`, and `qa_render.ps1` refuses to report success
  without checking the file's magic bytes.
- **Rendering blocked the whole host process**: `spawnSync` is gone; `renderDocument()` is async,
  kills the PowerShell tree on `exec.signal` abort, and keeps its own wall-clock backstop.
- **The skill could fail to load while the tools worked**: registration is now dual-channel —
  a `ctx.effect`-owned `skills.register()` (inline definition; ranked above provider entries, so
  the skill shows up even when the session's catalog was collected before this plugin mounted)
  plus a `ctx.effect`-owned `skills.registerProvider()` (disk-backed, keeps doc edits live).
  Measured 2026-11-05: the provider alone never appeared in the host's catalog, so a published
  plugin must not rely on it; the old global-slot "dispose and re-register on every apply" left
  the host catalog pointing at a disposed provider ("unknown or no longer available").
- **Structure gate**: `checkStructure()` catches the four failures that pass XML validation and
  still make Office refuse a file (empty `<p:sp/>`, duplicate `<p:cNvPr>` ids, dangling
  relationship targets, broken `<sheet r:id>`).
- **PDF reading**: `dump.mjs` reads `.pdf` (version, page count, metadata, fonts/images) and
  rejects a renamed zip with a message that names the cause.
- Error paths name the cause: directory, zero-byte file, renamed container, wrong extension.

### Known limitations
- Rendering needs Microsoft desktop Office (COM) in an interactive session; a locked-down or
  headless service account cannot render.
- PDF support is metadata/page level only — no text extraction, no form filling.
- Excel page counts need a printer driver; without one the report says `pages 0`.
