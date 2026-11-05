---
name: office-docs-win
description: "Create/edit/read .pptx, .docx, .xlsx, .pdf files on this Windows host (SUEZ intranet, no Python, no admin rights). Trigger on ANY mention of PPT/幻灯片/presentation/deck, Word 文档, Excel/表格/spreadsheet, PDF 生成/读取, 按模板做PPT, 复刻模板/风格, or rendering/QA (质检) of Office files. Ships its own JavaScript OOXML toolkit plus Office COM rendering; on this host it takes precedence over the built-in pptx/docx/xlsx/pdf skills tool chains (markitdown/Pillow/LibreOffice are unavailable)."
---

> **This build has no Python.** Every toolkit call uses Node:
> `node <scripts>/dump.mjs <file>` (structure dump) and `node <scripts>/ooxml.mjs check <file>`
> (integrity gate). `ooxml.mjs` is a line-by-line port of the original `ooxml.py` — same class
> and method names (`ZipDoc`, `part`, `setPart`, `save`, `checkPackageIntegrity`,
> `duplicateParaIds`) — and its output is verified byte-identical by a differential test suite.
> Where a recipe below still shows Python, write the equivalent `.mjs` instead:
> `import { ZipDoc, checkPackageIntegrity } from '<scripts>/ooxml.mjs'`. This host has no
> `python.exe`; a `python` command will simply fail.

# Office Documents on Windows (SUEZ intranet)

Use this skill for any .pptx / .docx / .xlsx / .pdf work on this machine.

## Prerequisites (what a colleague needs on a fresh machine — nothing else)
| Needed | Why | Notes |
|---|---|---|
| Windows 10/11 + PowerShell 5.1 | runs `qa_render.ps1` (rendering / PDF export) | built in, nothing to install |
| ~~Python 3~~ | **not needed in this build** | the plugin ships a JavaScript OOXML toolkit (node:zlib only); there is no `python.exe` on the host, so never emit a python command |
| **Microsoft desktop Office**: Word + Excel + PowerPoint, activated | the only render/export engine (COM) | Office **Online has no COM**; LibreOffice is not supported. Missing one app = that one format cannot be rendered (building/editing still works) |

**Not needed**: any pip package, LibreOffice, poppler, ImageMagick, Pillow, markitdown, .NET SDK, admin rights, internet access.

### No admin rights (locked-down corporate PC)
Nothing has to be installed: this plugin ships its own toolkit and runs it with the Node
executable DSH itself uses (a packaged DSH keeps one under its resources directory). Office
desktop is the only requirement, and it is already on these machines.
- Do **not** download or install Python; a `python` command fails on this host.
- Rendering still needs Office + PowerShell (`scripts/qa_render.ps1`), as documented below.
- If a recipe below still reads as Python, write the equivalent `.mjs` — same helper names.

## Environment facts (verified in production 2026-10 — do not re-test)
- Office (PowerPoint/Word/Excel) is installed → **Office COM automation is the render/QA engine**. COM is **environment-sensitive** (see Troubleshooting below): it works in interactive desktop sessions; flaky failures ("could not open", E_FAIL, RPC 0x800706BE) are almost always zombie processes, wrong temp-file extensions, or the headless-`WithWindow=$false` session issue on image decks — not file corruption.
- Files under OneDrive (the Documents tree) are sync-locked for COM → stage a copy in `$env:TEMP` before opening. Use `$env:TEMP`, not a hard-coded `C:\Temp`: under the DSH sandbox only the workspace and the session-private temp are writable, and `qa_render.ps1` already stages there automatically.
- **Rendering in a sandboxed session**: call the `office_docs_render` tool. It runs Office COM
  from the plugin host process (outside the tool sandbox), so it needs no `danger-full-access`
  approval, and it still stages a temp copy + watchdog + WithWindow fallback internally. Only
  fall back to a raw `pwsh` + COM script when the tool is unavailable — and then put ALL COM
  work for the job in one script, because each `pwsh` COM call costs one approval.

## Priority order (highest first)
1. **User's explicit requirements** in the current conversation.
2. **A template file provided by the user** (or "follow the style of X") → 100% replication, see below.
3. **SUEZ defaults** (below) — apply only for points not covered by 1 or 2.

## Template replication (HIGHEST PRIORITY when a template is given)
If the user asks to build a new deck/doc from a template file or in the style of an existing file:
1. **Dump the template completely before building anything**: `node scripts/dump.mjs <file>` (pptx mode: every slide's shapes, positions, text runs, fonts, sizes, colors; docx/xlsx modes included in the same script).
2. **Extract assets** from the template's `ppt/media/` / `word/media/` (logos, images, chart PNGs) into the working directory and reuse them.
3. **Replicate exactly** — the template's font names (including panose attributes), hex colors, spacing, margins, logo position, band/panel geometry. New slides must be visually indistinguishable from the template's own slides. Never apply generic defaults when a template exists.
4. **Preserve user edits**: if the user has been editing the file between sessions, re-dump the current file before each rebuild and diff against the last known state. Never silently discard user text changes or deleted elements.

## SUEZ defaults (only when no template and no user spec)
- **Fonts**: English = **poppins**, Chinese = **方正准圆_GBK**. Copy the exact run template with panose/pitchFamily/charset from [pptx.md](pptx.md) §Fonts — missing attributes make Office substitute the font.
- **Logo**: `assets/suez-logo.png` (bundled with this skill) at the **bottom-right** of each content page. For 16:9 (13.33×7.5 in): x≈11.9", y≈6.85", width≈1.25".
- **Palette**: NAVY `030F40` · GREEN `AADC14` · DARK `333F55` · MID `5A6B8C` · PANEL `F2F5FA` · GRID `D9E0EA` · LIGHT-BLUE `B8C4E0` · WHITE `FFFFFF`.
- Slides 16:9 (13.33×7.5 in). Text boxes: zero insets (`lIns/tIns/rIns/bIns=0`, `anchor="t"`).
- Charts: hand-written SVG with monotone cubic (Fritsch–Carlson, no overshoot) → PNG via PowerPoint COM; clean axis units; English labels unless the user asks otherwise.

## Standard workflow (every document job)
1. **Dump first**: inspect the input file with `scripts/dump.mjs` before touching it. If the user may have edited it mid-session, re-dump to capture changes.
2. **Build**: edit OOXML directly (pptx/docx/xlsx are zip packages). Zip/shape helpers: [ooxml.md](ooxml.md) + `scripts/ooxml.mjs`. Shape XML templates: [pptx.md](pptx.md).
3. **Package integrity check (mandatory before delivery)**: `checkPackageIntegrity(doc.parts)` must return `[]`. It covers both failure families: (a) the three fatal Content_Types modes PowerPoint refuses, and (b) **XML well-formedness of every `.xml`/`.rels` part** — a regex-built `document.xml` with mismatched tags passes a Content_Types-only check and then dies as "Word refuses to open". Cheap (0.04 s on the 28 MB / 419-shape deck here) and catches string-surgery mistakes at check time. Pass `checkXml: false` only on files you did not edit.
4. **Render QA (mandatory, no exceptions)**: call `office_docs_render` (file, page) — pptx
   gives a PNG, docx/xlsx a PDF; it runs Office COM in the plugin host, no approval needed.
   Inspect the PNG with `read_image`; for a PDF use the Edge trick below (no poppler here) and
   **assume the first render has bugs**: overflow past panel/slide, overlapping lines, legend
   wrapping, low contrast, last line hugging the bottom edge.
6. **Deliver**: a NEW versioned file (v10 → v11 …; never overwrite the file the user is editing), `present` it, inline preview image, short diff summary.

## Authoring recipes (JavaScript, verified)
Three runnable examples ship with this skill (`examples/`) — copy one and change its content
arrays instead of writing OOXML from a blank page:

| File | What it demonstrates |
|---|---|
| `examples/build_deck.mjs` | 16:9 SUEZ deck: band/panel/accent shapes, Poppins + 方正准圆_GBK runs, logo, and the **five-place slide wiring** (slide part, its .rels, presentation.xml.rels, sldIdLst) plus [Content_Types].xml — including the png-Default-only-if-absent rule |
| `examples/build_docx.mjs` | a .docx built from nothing (3 parts): paragraphs, runs, borders table, A4 section |
| `examples/build_xlsx.mjs` | an .xlsx built from nothing: inline strings, SUM/percent formulas with cached values, cell styles, column widths, frozen header |

    node examples/build_deck.mjs --seed <template.pptx> --out <new.pptx> [--logo <png>]
    node examples/build_docx.mjs --out <new.docx>
    node examples/build_xlsx.mjs --out <new.xlsx>

Each one runs `checkPackageIntegrity` before saving and prints CLEAN or the problem list.
All three are verified end-to-end: PowerPoint/Word/Excel open the output and render it.

## Format guides
- PPTX: [pptx.md](pptx.md) — shape XML, fonts, logo, COM render units, chart SVG template.
- DOCX: [docx.md](docx.md) — document.xml, Word COM.
- XLSX: [xlsx.md](xlsx.md) — sheet XML, Excel COM.
- PDF: [pdf.md](pdf.md) — what is actually possible here.

## Hard-won gotchas (all hit in production)
- COM `PageSetup.SlideWidth/SlideHeight` are in **points** (16:9 = 960×540), not EMU; the `SlideSize` property does not exist.
- **Duplicate `<Default Extension="...">` entries in `[Content_Types].xml` = PowerPoint refuses the whole package** ("could not open", HRESULT 0x80CB8000) while lenient renderers (Univer) still open it. Check before adding any Default/Override; a deck that ever contained PNGs already has the png Default even after media removal. (Reproduced & fixed 2026-10-29.)
- **Duplicate `<Override PartName="...">` entries are just as fatal (0x80CB8001)** — OPC requires unique part names, same rule as Defaults. Verified 2026-10-29 by adding a second identical slide1 Override to a deck that opened fine: PowerPoint refused it. Both duplicate modes are now caught by `checkPackageIntegrity`. Override pointing at a missing part and a relationship whose target part was deleted are now reported too (2026-11-04): they still open in PowerPoint, but they are always builder bugs, and `checkStructure` catches them before delivery.
- **`dump_docx` shows tables (`tables: N`, `[tbl]` marker) and dumps `word/header*/footer*.xml`** — real SUEZ submission templates keep their title and page numbers there; editing headers blind is how you break a replicated template.
- **`mc:AlternateContent` stores content twice** (Choice + Fallback). The dumper skips the Fallback branch so text/shapes are not reported twice — but if you edit something and see it "duplicated" in raw XML, that is why.
- **Rebuilding docx paragraphs from regex matches: put the self-closing form FIRST** — `<w:p\b[^>]*/>|<w:p\b[^>]*>.*?</w:p>`. Matching `.*?</w:p>` first swallows a following `<w:p .../>` into the previous block, and the rebuilt XML ends up with mismatched tags (observed 2026-10-30: Word refused the file, needed a bisect to find). The XML gate in `checkPackageIntegrity` now catches this before delivery.
- **Cloned paragraphs/tables keep `w14:paraId`** → duplicate ids break commentsExtended / revision references until Word repairs them on save. Clear or regenerate `w14:paraId`/`w14:textId` in cloned blocks; verify with `duplicateParaIds(doc.parts)` (empty = clean; duplicates inside `mc:Fallback` are legitimate and already excluded).
- **Field updates (TOC) can record phantom revisions even with `<w:trackChanges/>` absent** — Word tracks them from session state. After `$doc.Fields.Update()` always run `$doc.AcceptAllRevisions()`, then assert `<w:ins `/`<w:del ` counts are 0 before delivery.
- **The tracking property is `$doc.TrackRevisions`** (not `TrackChanges`, which does not exist on PS COM) — verified 2026-10-30: setting it to `$true` and inserting text gives `Revisions.Count = 1`.
- **COM `[ref]` arguments need a real `[string]`**: `$doc.SaveAs([ref]$p, [ref]17)` throws `Cannot convert the "…" value of type "psobject" to type "Object"` when `$p` came from a pipeline/`Join-Path` without a cast (reproduced 2026-10-30 in PS 5.1). Declare `[string]$p` or cast at the call — that form passed for both docx (16) and PDF (17). **By-value `SaveAs2($p, 17)` is NOT a fallback: it hangs** (>120 s, verified 2026-10-30).
- **Zombie Office COM processes** (headless, no main window) poison later COM calls: "could not open", `Shapes.AddPicture` E_FAIL, RPC 0x800706BE. Kill them before COM work; never kill instances with a visible window.
- **COM temp copies must keep the original extension** — `GetRandomFileName()` yields 8.3 form and breaks PowerPoint format detection.
- Injected shapes need unique ids: compute `max(cNvPr id)` first, then increment.
- Deleting shapes by name: duplicate names can exist (users add shapes with the same name) → disambiguate by `<a:off>` y; when keeping one, filter by position.
- 8pt text in a 2.4" box wraps at ≈42–46 chars/line — count characters before choosing wording; prefer one-line legend rows.
- Text boxes do **not** clip: overflowing text renders past the box → size boxes from estimated line count (lines × line-height + paragraph spacing), not content length.
- XML text escaping: `&` → `&amp;`; use escapes in code files for `–`(\u2013) `—`(\u2014) `×`(\u00d7) `·`(\u00b7) `≥`(\u2265).
- OneDrive files: re-read before overwriting (sync changes mtime/content); write zip to `.tmp` then `os.replace`.
- `ZipDoc.save()` preserves per-part compression (media stay STORED) and entry order; new parts are appended.
- `[bool]` parameters cannot be bound through `powershell -File` in PS 5.1 (value arrives as a string, conversion fails; even `-Flag 0` breaks) → script flags must be `[switch]` (e.g. `-NoWindow`) or plain strings. Verified 2026-10-29.

## Hard-won gotchas — round 2 (2026-11-04 full-format verification)

- **"The file exists" is not "the conversion worked".** The Excel branch shipped `SaveAs($dest, 52)` for a
  year; 52 is `xlOpenXMLWorkbookMacroEnabled`, so every "PDF" was an `.xlsm` renamed `.pdf`. Only a size
  check passed. Read the first bytes (`%PDF-`, `\x89PNG`) — `qa_render.ps1` now refuses to report success otherwise.
- **By-value `SaveAs` hangs; by-`[ref]` returns.** The log says "opened fine, hung on export" with no dialog.
  `$doc.SaveAs([ref]$dest, [ref]17)` is the working form. Excel is the exception: `ExportAsFixedFormat(0, $dest)`
  works by value. (Same trap as the `[ref]` note above — it cost another afternoon on 2026-11-04.)
- Saving **back** to docx/xlsx/pptx (`SaveAs` 16 / 51 / 24) unattended can sit on the format-conversion dialog
  forever. QA only needs **open + export PDF**, which never touches those formats.
- **A zombie Office process makes later COM calls hang, not fail.** Kill `WINWORD,EXCEL,POWERPNT` before any
  scripted COM run; a 90 s watchdog turns a silent hang into a one-line diagnosis.
- `checkPackageIntegrity` now also runs `checkStructure`: an empty `<p:sp/>`, a duplicate `<p:cNvPr id>`, a
  relationship pointing at a missing part and a `<sheet r:id>` with no such rel all pass XML validation and
  still make Office refuse the file.
- `dump.mjs` reads `.pdf` too (version, page count, metadata); a zip renamed `.pdf` is rejected by its header.

- **PDF visual QA without poppler**: open the PDF in the Edge-based browser lane (`file:///` URL
  + screenshot) and inspect it like a PNG. Verified 2026-11-04 on a Word-exported PDF. Background
  tabs often do not repaint the PDF viewer: a blank or byte-identical screenshot twice means the
  capture missed, not that the PDF is empty — verify content with `office_docs_dump` and re-try,
  or render a pptx page to PNG instead.

## COM troubleshooting (when rendering fails)
Symptom → cause → fix:
1. **"PowerPoint could not open the file"** → (a) temp copy lost its extension (use GUID + original ext); (b) zombie POWERPNT from a crashed session (kill headless instances); (c) if the file was just built with injected images: duplicate Content_Types Default entry; (d) **non-interactive session + deck with image parts: headless open (WithWindow=$false) fails even for valid packages** — open with WithWindow=$true instead (a brief window is enough); `qa_render.ps1` does this fallback automatically.
2. **`Shapes.AddPicture` E_FAIL / RPC 0x800706BE** → zombie/crashing PowerPoint instance. `qa_render.ps1` kills headless Office leftovers **before the first attempt** and retries once with another cleanup, so these no longer surface.
3. **Flaky "works on my run, fails on yours"** → COM state is shared per-session; always run `qa_render.ps1` (it pre-cleans + retries + window-fallback) instead of ad-hoc COM snippets. A fresh `New-Object -ComObject Word/Excel.Application` from another process does **not** hijack your already-open Office and `Quit()` leaves your documents alone (verified 2026-10-29) — the script will not close your work.
4. Bad page numbers are **not** retried: `qa_render.ps1` reports `page N out of range: this deck has M slide(s)` immediately.
5. **A COM call that hangs (no error, process alive)** → not a corrupt file. `qa_render.ps1` runs the render under a **watchdog** (auto budget: pptx 180 s, docx/xlsx 600 s; `-TimeoutSec N` overrides, `0` disables): on timeout it kills the child + headless Office leftovers, removes the temp copy and raises `render timed out after Ns … retry once`. Benchmark measured here: **21-page / 3.4 MB CJK docx → PDF 23 s (≈1.1 s/page)**, small docs 1–1.5 s. Never conclude "cannot export" before one clean retry.
6. **In a sandboxed session, COM hangs on `Documents.Open` even for good files** — use the
  `office_docs_render` tool (host process, no approval). A raw `pwsh` COM script needs
  `danger-full-access`; keep it to ONE script for the whole job.
7. Still failing → verify from an interactive desktop session; check Office installed and the file opens manually in PowerPoint (a genuinely corrupt file is the last suspect, not the first).
8. **Diagnostic order for "could not open" on a built file**: integrity check incl. XML gate (`checkPackageIntegrity`) → known-good file in the same session (isolates environment vs package) → with-window open (isolates WithWindow session issue) → only then suspect the package contents.