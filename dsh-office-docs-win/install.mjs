/**
 * One-click install for dsh-office-docs-win (Windows).
 *
 *   install.cmd          (double-click: finds Node itself, even inside a packaged DSH)
 *
 * What it does:
 *   1. finds the DSH profile (~/.dsh/profiles/web)
 *   2. `dsh plugin --profile web add file:<this folder>`  (no admin, no registry writes)
 *   3. adds the plugin entry to cordis.patch.yml (backs the file up first)
 *   4. verifies the deployed copy contains the JS toolkit
 *
 * Re-running is safe. Nothing is touched outside %USERPROFILE%\.dsh.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_NAME = 'dsh-office-docs-win';
const ENTRY_ID = 'office-docs-win';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE || 'web';
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
const PATCH_FILE = path.join(PROFILE_DIR, 'cordis.patch.yml');

const out = (s = '') => process.stdout.write(s + '\n');
const ok = (s) => out(`  [ok] ${s}`);
const warn = (s) => out(`  [!!] ${s}`);
const fail = (s) => out(`  [xx] ${s}`);

function die(msg, hint) {
  out('');
  fail(msg);
  if (hint) out(`       ${hint}`);
  out('');
  process.exitCode = 1;
  process.exit(1);
}

function findOnPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of ['.cmd', '.exe', '.bat', '']) {
        const p = path.join(dir, name + ext);
        try {
          if (fs.statSync(p).isFile()) return p;
        } catch { /* keep looking */ }
      }
    }
  }
  return null;
}

const quote = (s) => (/[\s"]/.test(s) ? '"' + s + '"' : s);
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/** Merge `- id/name` into cordis.patch.yml, keeping any existing content. */
export function mergePatchEntry(text, entryId = ENTRY_ID, pkgName = PKG_NAME) {
  if (new RegExp(`^\\s*-\\s*id:\\s*${entryId}\\s*$`, 'm').test(text)) return { text, changed: false };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^-\s*insert:\s*$/.test(l));
  if (start === -1) {
    const body = lines.slice();
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    const block = ['- insert:', `    - id: ${entryId}`, `      name: ${pkgName}`];
    return { text: [...body, ...block].join('\n') + '\n', changed: true };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^-\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let indent = '    ';
  for (let i = start + 1; i < end; i++) {
    const m = /^(\s+)- /.exec(lines[i]);
    if (m) {
      indent = m[1];
      break;
    }
  }
  let at = end;
  while (at > start + 1 && lines[at - 1].trim() === '') at--;
  const item = [`${indent}- id: ${entryId}`, `${indent}  name: ${pkgName}`];
  return { text: [...lines.slice(0, at), ...item, ...lines.slice(at)].join('\n'), changed: true };
}

function run(args) {
  out(`       ${args[0]} ${args.slice(1).join(' ')}`);
  // Node >= 18.20 refuses to spawn .cmd/.bat without a shell (CVE-2024-27980), and the
  // `dsh` shim on PATH is exactly that, so route those through the shell.
  const isBatch = /\.(cmd|bat)$/i.test(args[0]);
  const r = isBatch
    ? spawnSync(args.map(quote).join(' '), { shell: true, stdio: 'inherit' })
    : spawnSync(args[0], args.slice(1), { stdio: 'inherit' });
  if (r.error) warn(`启动失败：${r.error.code || r.error.message}`);
  return r.status === 0;
}

async function main() {
  out('');
  out('==========================================================');
  out(' dsh-office-docs-win  —  Office 文档插件一键安装');
  out(' 不需要 Python，不需要管理员权限');
  out('==========================================================');
  out('');

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) die(`Node.js 版本太旧（${process.versions.node}）`, '需要 Node 20 及以上。');
  ok(`Node.js ${process.versions.node}`);

  if (!fs.existsSync(PROFILE_DIR)) {
    die(
      `没找到 DSH profile：${PROFILE_DIR}`,
      '请先启动一次 DSH，让它把 profile 建出来，再回来双击本脚本。',
    );
  }
  ok(`DSH profile：${PROFILE_DIR}`);

  const dsh = process.env.DSH_BIN || findOnPath(['dsh']);
  if (!dsh) {
    die(
      '没找到 dsh 命令（PATH 里没有）',
      [
        '这种情况下请改用图形界面安装（同样是一键）：',
        `  DSH 侧边栏 → Plugins → 安装 → 选择本文件夹：${HERE}`,
        '或把本文件夹打成 tgz 后在该界面填入 tgz 路径。',
      ].join('\n       '),
    );
  }
  ok(`dsh：${dsh}`);

  const installedDir = path.join(PROFILE_DIR, 'node_modules', PKG_NAME);
  const localVersion = readJson(path.join(HERE, 'package.json'))?.version ?? '0.0.0';
  const deployedVersion = readJson(path.join(installedDir, 'package.json'))?.version ?? null;

  out('');
  out('[1/3] 装进 profile ...');
  if (deployedVersion) {
    out(`       已装 ${deployedVersion} → 本次 ${localVersion}，先移除旧副本`);
    run([dsh, 'plugin', '--profile', PROFILE, 'remove', PKG_NAME]);
  }
  if (!run([dsh, 'plugin', '--profile', PROFILE, 'add', `file:${HERE}`])) {
    die('安装到 profile 失败（pnpm 报错见上方）', '常见原因：DSH 正在写同一份 profile，稍后重试。');
  }
  const toolkit = path.join(installedDir, 'assets', 'office-docs-win', 'scripts', 'dump.mjs');
  if (!fs.existsSync(toolkit)) {
    die(`profile 里的副本不完整（缺 ${toolkit}）`, `pnpm 可能缓存了旧副本：删掉 ${installedDir} 再试。`);
  }
  ok(`已装入 profile（${readJson(path.join(installedDir, 'package.json'))?.version ?? localVersion}）`);

  out('');
  out('[2/3] 挂载条目 ...');
  const manifest = readJson(path.join(HERE, 'package.json')) || {};
  if (manifest.dsh && manifest.dsh.bundle) {
    ok('包自带 cordis.patch.yml（dsh.bundle），不改动你的配置文件');
  } else {
  let text = '';
  try {
    text = fs.readFileSync(PATCH_FILE, 'utf8');
  } catch {
    text = '';
  }
  const merged = mergePatchEntry(text);
  if (!merged.changed) {
    ok(`${ENTRY_ID} 已存在，跳过`);
  } else {
    if (text) fs.writeFileSync(PATCH_FILE + '.bak', text, 'utf8');
    fs.mkdirSync(path.dirname(PATCH_FILE), { recursive: true });
    fs.writeFileSync(PATCH_FILE, merged.text, 'utf8');
    ok(`已写入 ${ENTRY_ID}${text ? '（原文件备份为 cordis.patch.yml.bak）' : ''}`);
  }
  }

  out('');
  out('[3/4] 自检 ...');
  const probe = path.join(installedDir, 'lib', 'index.js');
  if (!fs.existsSync(probe)) die(`缺少 ${probe}`, '安装副本不完整，请重试。');
  try {
    execFileSync(process.execPath, [
      '-e',
      `import(${JSON.stringify('file:///' + probe.replace(/\\/g, '/'))}).then((m) => {
         if (typeof m.apply !== 'function') { console.error('apply missing'); process.exit(1); }
         console.log('plugin module loads: name=' + m.name + ' inject=' + JSON.stringify(m.inject));
       });`,
    ], { stdio: 'inherit' });
    ok('插件模块可加载');
  } catch {
    die('插件模块加载失败', '把上面的报错发给维护人。');
  }

  out('');
  // The plugin registers the skill through BOTH documented channels since 1.0.0 (verified
  // 2026-11-05: the skill loads from the profile's own assets after a restart, for the main
  // session and for subagents, with no ~/.dsh/skills copy at all). The copy therefore stays
  // opt-in: it ranks 400 and would *shadow* the bundled 600 version, i.e. two docs that drift.
  if (process.argv.includes('--copy-skill')) {
    out('[4/4] 技能副本（可选，--copy-skill：给 1.0.0 之前的宿主用）...');
    writeSkillCopy(path.join(installedDir, 'assets', 'office-docs-win'));
  } else {
    out('[4/4] 技能副本：不写（插件自己注册技能；需要时加 --copy-skill）');
  }

  out('');
  out('安装完成。');
  out('  请重启 DeepSeek Harness（退出后重新打开），技能目录才会刷新。');
  out('  工具（office_docs_check / dump / render）重启前也能用；技能不在目录里时重启一次即可。');
  out('  重启后新建会话，说一句「用 office-docs-win 看看这个 pptx」即可验证。');
  out('技能名：office-docs-win   工具名：office_docs_check / office_docs_dump / office_docs_render');
  out('');
}

/**
 * Mirror the skill into ~/.dsh/skills/office-docs-win.
 *
 * The plugin serves the skill to the main session through a runtime provider, but a
 * provider registration is not visible to subagents (measured 2026-11-04: `outlook` and
 * `owa`, which live on disk, load fine in a subagent; this one did not) and is not
 * visible at all before the first restart. A plain directory copy fixes both cases.
 *
 * It is refreshed on every install and carries a marker file, so it is only ever
 * overwritten when we wrote it ourselves — never a user's own folder.
 */
function writeSkillCopy(sourceDir) {
  const target = path.join(DSH_HOME, 'skills', 'office-docs-win');
  const marker = path.join(target, '.installed-by-plugin');
  if (fs.existsSync(target) && !fs.existsSync(marker)) {
    warn(`已存在 ${target}（不是本插件写入的），保持原样不动`);
    return;
  }
  try {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of ['SKILL.md', 'pptx.md', 'docx.md', 'xlsx.md', 'ooxml.md', 'pdf.md', 'scripts', 'examples', 'assets']) {
      const from = path.join(sourceDir, entry);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(target, entry), { recursive: true, force: true });
    }
    fs.writeFileSync(marker, `installed ${new Date().toISOString()} from ${sourceDir}\n`, 'utf8');
    ok(`技能副本：${target}`);
  } catch (err) {
    warn(`技能副本写入失败（主会话不受影响）：${err && err.message ? err.message : String(err)}`);
  }
}

main().catch((err) => die(err && err.message ? err.message : String(err)));
