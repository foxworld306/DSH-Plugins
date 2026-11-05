#!/usr/bin/env node
/**
 * 一键安装（Windows）：双击 install.cmd 即可，不需要改任何配置文件。
 *
 * 做四件事：
 *   1) 探测可用的 Chromium 系浏览器（默认浏览器优先），把结果显示出来；
 *   2) 把本目录装进 DSH 的 web profile（等价于 dsh plugin --profile web add file:<本目录>）；
 *   3) 在 ~/.dsh/profiles/web/cordis.patch.yml 里补上 outlook-owa 条目（已有则跳过，改前备份）；
 *   4) 若还没开登录窗口，顺手打开一个，方便当场登录 OWA。
 *
 * 重复运行是安全的：装包幂等、YAML 有条目就跳过、浏览器已在跑就不重开。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultPort, defaultProfileDir, resolveBrowser } from './src/browser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_NAME = 'dsh-plugin-outlook-owa';
const ENTRY_ID = 'outlook-owa';
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
  const exts = ['.cmd', '.exe', '.bat'];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = path.join(dir, name + ext);
        try {
          if (fs.statSync(p).isFile()) return p;
        } catch {}
      }
    }
  }
  return null;
}

const quote = (s) => (/[\s"]/.test(s) ? '"' + s + '"' : s);

function readVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

function runShell(line) {
  const r = spawnSync(line, { shell: true, stdio: 'inherit' });
  if (r.error) return { status: 1, error: r.error };
  return { status: r.status };
}

function httpJson(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 2500 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** 把条目并进 cordis.patch.yml：已有 insert 块就追加条目，没有就新建块。 */
export function mergePatchEntry(text, entryId = ENTRY_ID, pkgName = PKG_NAME) {
  if (new RegExp(`^\\s*-\\s*id:\\s*${entryId}\\s*$`, 'm').test(text)) {
    return { text, changed: false };
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^-\s*insert:\s*$/.test(l));

  if (start === -1) {
    const body = lines.slice();
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    const block = ['- insert:', `    - id: ${entryId}`, `      name: ${pkgName}`];
    return { text: [...body, ...block].join('\n') + '\n', changed: true };
  }

  // insert 块的范围：到下一个顶层 `- ` 开头的行为止
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^-\s/.test(lines[i])) { end = i; break; }
  }
  // 沿用块内已有条目的缩进
  let indent = '    ';
  for (let i = start + 1; i < end; i++) {
    const m = /^(\s+)- /.exec(lines[i]);
    if (m) { indent = m[1]; break; }
  }
  let at = end;
  while (at > start + 1 && lines[at - 1].trim() === '') at--;
  const item = [`${indent}- id: ${entryId}`, `${indent}  name: ${pkgName}`];
  const merged = [...lines.slice(0, at), ...item, ...lines.slice(at)];
  return { text: merged.join('\n'), changed: true };
}

async function main() {
  out('');
  out('==========================================================');
  out(' dsh-plugin-outlook-owa 一键安装');
  out(' 让 DeepSeek Harness 读写你的 Outlook 邮件与日历');
  out('==========================================================');
  out('');

  // 0) 环境检查
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) die(`Node.js 版本太旧（${process.versions.node}）`, '需要 Node 20 及以上：https://nodejs.org/');
  ok(`Node.js ${process.versions.node}`);

  if (!fs.existsSync(PROFILE_DIR)) {
    die(
      `没找到 DSH 的 profile：${PROFILE_DIR}`,
      '请先启动一次 DSH（在命令行运行 dsh web），让它把 profile 建出来，再回来双击本脚本。',
    );
  }
  ok(`DSH profile：${PROFILE_DIR}`);

  // 1) 浏览器探测
  let browser = null;
  try {
    browser = resolveBrowser('auto');
    ok(`浏览器：${browser.exe}`);
    out(`       来源：${browser.source}`);
    if (browser.progId && browser.key && browser.source.startsWith('已安装')) {
      warn(`默认浏览器 ${browser.progId} 不是 Chromium 内核，已改用它；想用 Chrome 的话把它设为默认浏览器即可。`);
    }
  } catch (e) {
    warn(`没找到 Chromium 系浏览器：${e.message}`);
    out('       安装 Chrome 或 Edge 之后再双击本脚本即可。');
  }

  // 2) 装进 profile
  out('');
  out('[1/3] 装进 DSH profile ...');
  const dsh = process.env.DSH_BIN || findOnPath(['dsh']);
  const installedDir = path.join(PROFILE_DIR, 'node_modules', PKG_NAME);
  const localVersion = readVersion(HERE);
  const oldVersion = readVersion(installedDir);

  const cli = dsh ? path.basename(dsh) : 'npx -y @deepseek-ai/dsh';
  const runner = (args) => {
    const line = dsh
      ? [quote(dsh), ...args.map(quote)]
      : [quote(findOnPath(['npx'])), '-y', '@deepseek-ai/dsh', ...args.map(quote)];
    out(`       ${cli} ${args.join(' ')}`);
    const r = runShell(line.join(' '));
    if (!r.status && r.error) warn(`启动失败：${r.error.code || r.error.message}`);
    return r.status === 0;
  };

  if (!dsh && !findOnPath(['npx'])) {
    die('没找到 dsh 命令', '先装好 DSH（npm i -g @deepseek-ai/dsh）再运行本脚本。');
  }

  // pnpm 对 file: 依赖只看路径、不看目录内容：装过旧副本时必须先移除，
  // 否则会一直报 "Already up to date" 继续用旧代码。
  if (oldVersion) {
    out(`       已装版本 ${oldVersion} → 本次 ${localVersion}，先移除旧副本`);
    if (!runner(['plugin', '--profile', PROFILE, 'remove', PKG_NAME])) {
      warn('移除旧副本失败，继续尝试安装（若后面仍是旧版本，请手动删掉 node_modules 里的插件目录）');
    }
  }
  const installed = runner(['plugin', '--profile', PROFILE, 'add', `file:${HERE}`]);
  if (!installed) {
    die('安装到 profile 失败（pnpm 报错见上方输出）', '常见原因：网络/代理装不上、或 DSH 正在写同一份 profile，稍后重试。');
  }

  // 校验副本确实是这次的代码，而不是缓存里的旧副本
  const deployedVersion = readVersion(installedDir);
  if (!fs.existsSync(path.join(installedDir, 'src', 'browser.js'))) {
    die(
      `profile 里的副本是旧的（${deployedVersion || '未知版本'}，缺少 src/browser.js）`,
      'pnpm 缓存了旧副本。手动删除 ' + installedDir + ' 后重新双击本脚本。',
    );
  }
  ok(`已装入 profile（${deployedVersion || localVersion}）`);

  // 3) 补配置条目
  out('');
  out('[2/3] 检查 cordis.patch.yml ...');
  let text = '';
  try {
    text = fs.readFileSync(PATCH_FILE, 'utf8');
  } catch {
    text = '';
  }
  const merged = mergePatchEntry(text);
  if (!merged.changed) {
    ok('条目已存在，跳过');
  } else {
    if (text) {
      try { fs.copyFileSync(PATCH_FILE, PATCH_FILE + '.bak'); } catch {}
    }
    fs.writeFileSync(PATCH_FILE, merged.text, 'utf8');
    ok(`已写入 ${ENTRY_ID}${text ? '（原文件备份为 cordis.patch.yml.bak）' : ''}`);
  }

  // 4) 登录窗口
  out('');
  out('[3/3] 登录窗口 ...');
  const port = Number(defaultPort());
  const up = await httpJson(port, '/json/version');
  if (up) {
    ok(`已有浏览器在调试端口 ${port} 上，直接复用（${up.Browser || 'unknown'}）`);
  } else if (!browser) {
    warn('没有可用浏览器，跳过打开登录窗口');
  } else {
    const profileDir = defaultProfileDir();
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch {}
    const args = [
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      'https://outlook.office.com/mail/',
    ];
    const child = spawn(browser.exe, args, { detached: true, stdio: 'ignore' });
    child.unref();
    let opened = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await httpJson(port, '/json/version')) { opened = true; break; }
    }
    if (opened) {
      ok(`已打开登录窗口（profile：${profileDir}）`);
      out('       请在那个窗口里用公司账号登录 OWA，并勾选“保持登录状态”。');
    } else {
      warn(`浏览器没能打开调试端口 ${port}，稍后首次使用时插件会再试一次。`);
    }
  }

  // 收尾
  out('');
  out('==========================================================');
  out(' 完成。下一步：');
  out('   1) 重启 DSH（关掉 DSH 窗口后重新运行 dsh web，或在 GUI 里重启）');
  out('   2) 在会话里说：「看看我今天的邮件」');
  out('');
  out(' 之后不用再运行本脚本；换机器或清缓存后重新双击一次即可。');
  out('==========================================================');
  out('');
}

const invokedDirectly = (() => {
  try {
    return path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((e) => {
    out('');
    fail(e && e.stack ? e.stack : String(e));
    process.exitCode = 1;
  });
}
