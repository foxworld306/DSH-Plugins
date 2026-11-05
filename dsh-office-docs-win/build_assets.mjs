/**
 * Build the plugin's asset tree from the original skill folder:
 * docs (adapted for the no-Python build) + the JS toolkit + rendering assets.
 *
 *   node build_assets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = path.resolve(HERE, '..');
const SRC = path.join(WS, 'office-docs-win');
const JS = path.join(WS, 'office-docs-win-js', 'scripts');
const DEST = path.join(HERE, 'assets', 'office-docs-win');

const BANNER = `> **This build has no Python.** Every toolkit call uses Node:
> \`node <scripts>/dump.mjs <file>\` (structure dump) and \`node <scripts>/ooxml.mjs check <file>\`
> (integrity gate). \`ooxml.mjs\` is a line-by-line port of the original \`ooxml.py\` — same class
> and method names (\`ZipDoc\`, \`part\`, \`setPart\`, \`save\`, \`checkPackageIntegrity\`,
> \`duplicateParaIds\`) — and its output is verified byte-identical by a differential test suite.
> Where a recipe below still shows Python, write the equivalent \`.mjs\` instead:
> \`import { ZipDoc, checkPackageIntegrity } from '<scripts>/ooxml.mjs'\`. This host has no
> \`python.exe\`; a \`python\` command will simply fail.
`;

function adapt(name, text) {
  let out = text
    .replace(/python\s+scripts[\\/]ooxml\.py/g, 'node scripts/ooxml.mjs')
    .replace(/python\s+scripts[\\/]dump_pptx\.py/g, 'node scripts/dump.mjs')
    .replace(/py\s+-3\s+scripts[\\/](ooxml|dump_pptx)\.(py)/g, (m, a) => `node scripts/${a === 'ooxml' ? 'ooxml.mjs' : 'dump.mjs'}`);

  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(out);
  out = fm ? out.slice(0, fm[0].length) + '\r\n' + BANNER + out.slice(fm[0].length) : BANNER + out;

  if (name === 'SKILL.md') {
    out = out.replace(
      /^description:[\s\S]*?(?=\r?\n)/m,
      'description: "Create/edit/read .pptx, .docx, .xlsx, .pdf files on this Windows host (SUEZ intranet, no Python, no admin rights). Trigger on ANY mention of PPT/幻灯片/presentation/deck, Word 文档, Excel/表格/spreadsheet, PDF 生成/读取, 按模板做PPT, 复刻模板/风格, or rendering/QA (质检) of Office files. Ships its own JavaScript OOXML toolkit plus Office COM rendering; on this host it takes precedence over the built-in pptx/docx/xlsx/pdf skills tool chains (markitdown/Pillow/LibreOffice are unavailable)."',
    );
    out = out.replace(
      /\| \*\*Python 3\.7\+\*\*[^\r\n]*\r?\n/,
      '| ~~Python 3~~ | **not needed in this build** | the plugin ships a JavaScript OOXML toolkit ' +
        '(node:zlib only); there is no `python.exe` on the host, so never emit a python command |\r\n',
    );
    out = out.replace(
      /\| Windows 10\/11 \+ PowerShell 5\.1 \|[^\r\n]*\r?\n/,
      '| Windows 10/11 + PowerShell 5.1 | runs `qa_render.ps1` (rendering / PDF export) | built in, nothing to install |\r\n',
    );
    out = out.replace(
      /### No admin rights \(locked-down corporate PC\)[\s\S]*?(?=\r?\n### |\r?\n## )/,
      `### No admin rights (locked-down corporate PC)
Nothing has to be installed: this plugin ships its own toolkit and runs it with the Node
executable DSH itself uses (a packaged DSH keeps one under its resources directory). Office
desktop is the only requirement, and it is already on these machines.
- Do **not** download or install Python; a \`python\` command fails on this host.
- Rendering still needs Office + PowerShell (\`scripts/qa_render.ps1\`), as documented below.
- If a recipe below still reads as Python, write the equivalent \`.mjs\` — same helper names.
`,
    );
    // the JS authoring examples are the recipes now — point at them from the workflow
    out = out.replace(
      /## Format guides/,
      `## Authoring recipes (JavaScript, verified)
Three runnable examples ship with this skill (\`examples/\`) — copy one and change its content
arrays instead of writing OOXML from a blank page:

| File | What it demonstrates |
|---|---|
| \`examples/build_deck.mjs\` | 16:9 SUEZ deck: band/panel/accent shapes, Poppins + 方正准圆_GBK runs, logo, and the **four-place slide wiring** (slide part, its .rels, presentation.xml.rels, sldIdLst) plus [Content_Types].xml — including the png-Default-only-if-absent rule |
| \`examples/build_docx.mjs\` | a .docx built from nothing (3 parts): paragraphs, runs, borders table, A4 section |
| \`examples/build_xlsx.mjs\` | an .xlsx built from nothing: inline strings, SUM/percent formulas with cached values, cell styles, column widths, frozen header |

    node examples/build_deck.mjs --seed <template.pptx> --out <new.pptx> [--logo <png>]
    node examples/build_docx.mjs --out <new.docx>
    node examples/build_xlsx.mjs --out <new.xlsx>

Each one runs \`checkPackageIntegrity\` before saving and prints CLEAN or the problem list.
All three are verified end-to-end: PowerPoint/Word/Excel open the output and render it.

## Format guides`,
    );

    // PDF visual QA without poppler: Edge renders it
    out = out.replace(
      /^## COM troubleshooting/m,
      `- **PDF visual QA without poppler**: open the PDF in the Edge-based browser lane (\`file:///\` URL
  + screenshot) and inspect it like a PNG. Verified 2026-11-04 on a Word-exported PDF. Background
  tabs often do not repaint the PDF viewer: a blank or byte-identical screenshot twice means the
  capture missed, not that the PDF is empty — verify content with \`office_docs_dump\` and re-try,
  or render a pptx page to PNG instead.

## COM troubleshooting`,
    );
    // stale environment bullets that only made sense for the Python build
    out = out
      .replace(/^- \*\*No pip installs\*\*[^\r\n]*\r?\n/m, '')
      .replace(/^- PowerShell TLS is broken[^\r\n]*\r?\n/m, '')
      .replace(/^- The Store Python on this host[^\r\n]*\r?\n/m, '')
      .replace(/^- \*\*Python 3\.10\.11 \(Store\)\*\*[^\r\n]*\r?\n/m, '')
      .replace(/^- PS escaping bites on inline `python -c`[^\r\n]*\r?\n/m, '');
  }
  // bare mentions the invocation rewrite does not catch
  out = out
    .replace(/scripts[\\/]dump_pptx\.py/g, 'scripts/dump.mjs')
    .replace(/scripts[\\/]ooxml\.py/g, 'scripts/ooxml.mjs')
    .replace(/ooxml\.check_package_integrity/g, 'checkPackageIntegrity')
    .replace(/check_package_integrity/g, 'checkPackageIntegrity')
    .replace(/ooxml\.duplicate_para_ids/g, 'duplicateParaIds');

  if (name === 'SKILL.md') {
    // rows/paragraphs that describe the old standalone-skill install and a script we do not ship
    out = out
      .replace(/^\| DeepSeek Harness, with this folder in[^\r\n]*\r?\n/m, '')
      .replace(/\*\*Verify in one command\*\*[\s\S]*?exit code 0 = ready\.[^\r\n]*\r?\n/, '')
      .replace(/^    powershell -ExecutionPolicy Bypass -File scripts\\check_env\.ps1[^\r\n]*\r?\n/m, '')
      .replace(/\r?\n\r?\n\r?\n+/g, '\r\n\r\n');
  }

  // The render tool made the "one danger-full-access approval" advice obsolete — worse,
  // following it costs the colleague an approval gate they cannot pass. Route to the tool.
  out = out.replace(
    /- \*\*In the DSH sandbox, Office COM needs an unrestricted process\*\*[\s\S]*?instead of one per operation\./,
    `- **Rendering in a sandboxed session**: call the \`office_docs_render\` tool. It runs Office COM
  from the plugin host process (outside the tool sandbox), so it needs no \`danger-full-access\`
  approval, and it still stages a temp copy + watchdog + WithWindow fallback internally. Only
  fall back to a raw \`pwsh\` + COM script when the tool is unavailable — and then put ALL COM
  work for the job in one script, because each \`pwsh\` COM call costs one approval.`,
  );
  out = out.replace(
    /4\. \*\*Render QA \(mandatory, no exceptions\)\*\*: `powershell -File scripts\/qa_render\.ps1 [^\n]*\n[^\n]*\n/,
    `4. **Render QA (mandatory, no exceptions)**: call \`office_docs_render\` (file, page) — pptx
   gives a PNG, docx/xlsx a PDF; it runs Office COM in the plugin host, no approval needed.
   Inspect the PNG with \`read_image\`; for a PDF use the Edge trick below (no poppler here) and
   **assume the first render has bugs**: overflow past panel/slide, overlapping lines, legend
   wrapping, low contrast, last line hugging the bottom edge.
`,
  );
  out = out.replace(
    /6\. \*\*In the DSH sandbox, COM hangs on `Documents\.Open` even for good files\*\*[^\n]*\n/,
    `6. **In a sandboxed session, COM hangs on \`Documents.Open\` even for good files** — use the
  \`office_docs_render\` tool (host process, no approval). A raw \`pwsh\` COM script needs
  \`danger-full-access\`; keep it to ONE script for the whole job.
`,
  );
  out = out.replace(/`check_xml=False`/g, '`checkXml: false`');
  out = out.replace(/four-place slide wiring/g, 'five-place slide wiring');
  return out;
}

// keep examples/ — it is hand-written source that ships verbatim (and imports ../scripts)
if (fs.existsSync(DEST)) {
  for (const entry of fs.readdirSync(DEST)) {
    if (entry !== 'examples') fs.rmSync(path.join(DEST, entry), { recursive: true, force: true });
  }
}
fs.mkdirSync(path.join(DEST, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(DEST, 'assets'), { recursive: true });

// The format guides still carry a few Python-era fragments; fix them at build time so a
// rebuild cannot bring them back, and point each guide at the runnable JS example.
const GUIDE_EXAMPLE = {
  'pptx.md': 'build_deck.mjs',
  'docx.md': 'build_docx.mjs',
  'xlsx.md': 'build_xlsx.mjs',
};

function adaptGuide(md, text) {
  let out = text
    .replace(/doc\.set_part\(/g, 'doc.setPart(')
    .replace(
      /- 参考实现：本会话 `make_chart\.py`[^\n]*/,
      '- 参考实现：本页的 SVG 模板 + PowerPoint COM 导出 PNG（本机没有 Python，不要调用 `.py` 脚本）',
    )
    .replace(
      /- 文本\/表格抽取：Python 标准库解析不了 PDF 内容流（Flate\+字体编码）——\*\*不做原始抽取\*\*。/,
      '- 文本/表格抽取：本机没有可用的 PDF 文本抽取库（内容流是 Flate 压缩 + 字体编码）——**不做原始抽取**。',
    );
  const example = GUIDE_EXAMPLE[md];
  if (example && !out.includes('examples/' + example)) {
    const lines = out.split(/\r?\n/);
    const at = lines.findIndex((line) => /^#\s/.test(line));
    const pointer = `> 要从零生成一个完整文件：拷 \`examples/${example}\`，改里面的内容数组即可（已跑通、含完整性检查）。`;
    if (at === -1) out = pointer + '\n\n' + out;
    else {
      lines.splice(at + 1, 0, '', pointer);
      out = lines.join('\n');
    }
  }
  return out;
}

for (const md of ['SKILL.md', 'docx.md', 'pptx.md', 'xlsx.md', 'ooxml.md', 'pdf.md']) {
  const text = fs.readFileSync(path.join(SRC, md), 'utf8');
  fs.writeFileSync(path.join(DEST, md), adaptGuide(md, adapt(md, text)), 'utf8');
}

for (const [from, to] of [
  [path.join(JS, 'ooxml.mjs'), path.join(DEST, 'scripts', 'ooxml.mjs')],
  [path.join(JS, 'dump.mjs'), path.join(DEST, 'scripts', 'dump.mjs')],
  [path.join(SRC, 'scripts', 'qa_render.ps1'), path.join(DEST, 'scripts', 'qa_render.ps1')],
  [path.join(SRC, 'assets', 'suez-logo.png'), path.join(DEST, 'assets', 'suez-logo.png')],
  [path.join(SRC, 'assets', '_selftest.pptx'), path.join(DEST, 'assets', '_selftest.pptx')],
]) {
  fs.copyFileSync(from, to);
}

const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push([path.relative(DEST, p), fs.statSync(p).size]);
  }
};
walk(DEST);
console.log('=== asset tree ===');
for (const [rel, size] of files.sort()) console.log(`${String(Math.round(size / 1024)).padStart(5)} KB  ${rel}`);

console.log('\n=== python mentions in SKILL.md ===');
const skill = fs.readFileSync(path.join(DEST, 'SKILL.md'), 'utf8');
skill.split(/\r?\n/).forEach((line, i) => {
  if (/python/i.test(line)) console.log(`  ${i + 1}: ${line.trim().slice(0, 110)}`);
});
