/**
 * 浏览器解析（Windows + Chromium 系）。
 *
 * 目标：同事不用改任何配置。`edgePath` 缺省或写成 'auto' 时按这个顺序挑：
 *   1) Windows 默认浏览器的 ProgId —— 是 Chromium 系（Chrome/Edge/Brave/Vivaldi/Opera/Chromium）
 *      就直接用它的 exe。默认是 Edge 的机器和默认是 Chrome 的机器都走这条。
 *   2) 默认浏览器不是 Chromium（Firefox 等）或读不到注册表 —— 按 Chrome → Edge → Brave →
 *      Vivaldi → Opera → Chromium 找第一个装了的。
 *   3) 都没有才报错，并说清「需要装一个 Chromium 系浏览器」。
 *
 * 为什么限定 Chromium：整套逻辑靠 CDP（`/json/version` + WebSocket + `Runtime.evaluate`）
 * 在已登录的 OWA 页面里跑 JS。Firefox 的远程调试是 WebDriver BiDi / Marionette，
 * Safari 是另一套，协议不同，不能复用这段会话层。
 *
 * 注意：即便默认浏览器是 Chrome，也**不会**用他平时那个窗口 —— 会另开一个带独立
 * `--user-data-dir` 的实例。原因有两个：Chrome 136 起禁止在默认 profile 上开调试端口；
 * 而且在默认 profile 上带调试端口启动时，已经在跑的实例会把命令行转交给老进程后退出，
 * 端口根本不生效。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

const env = process.env;
const PF = env.ProgramFiles || 'C:\\Program Files';
const PF86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LAD = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

const LABEL = {
  chrome: 'Chrome',
  edge: 'Edge',
  brave: 'Brave',
  vivaldi: 'Vivaldi',
  opera: 'Opera',
  chromium: 'Chromium',
};

/** 每种浏览器的常见安装位置（按顺序探测第一个存在的）。 */
const CANDIDATES = {
  chrome: [
    path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(LAD, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ],
  edge: [
    path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ],
  brave: [
    path.join(PF, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(PF86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(LAD, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ],
  vivaldi: [
    path.join(LAD, 'Vivaldi', 'Application', 'vivaldi.exe'),
    path.join(PF, 'Vivaldi', 'Application', 'vivaldi.exe'),
  ],
  opera: [
    path.join(LAD, 'Programs', 'Opera', 'opera.exe'),
    path.join(PF, 'Opera', 'opera.exe'),
    path.join(PF86, 'Opera', 'opera.exe'),
  ],
  chromium: [
    path.join(LAD, 'Chromium', 'Application', 'chrome.exe'),
    path.join(PF, 'Chromium', 'Application', 'chrome.exe'),
  ],
};

/** 回退顺序：默认浏览器不可用时依次尝试。 */
const FALLBACK_ORDER = ['chrome', 'edge', 'brave', 'vivaldi', 'opera', 'chromium'];

/** ProgId → 浏览器 key。 */
const PROGID_RULES = [
  [/^MSEdge/i, 'edge'],
  [/^ChromeHTML$/i, 'chrome'],
  [/^BraveHTML$/i, 'brave'],
  [/^VivaldiHTM$/i, 'vivaldi'],
  [/^Opera/i, 'opera'],
  [/^Chromium/i, 'chromium'],
];

const URL_ASSOC_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';

const PORT = () => Number(process.env.OWA_CDP_PORT || 9333);

/** 插件的默认 CDP 端口与 profile 目录——install.mjs 与 session.js 共用这一份。 */
export const defaultPort = () => PORT();

export function defaultProfileDir() {
  return (
    process.env.OWA_PROFILE_DIR ||
    path.join(env.LOCALAPPDATA || os.homedir(), 'dsh-outlook-owa', 'profile')
  );
}

/**
 * 读 Windows 默认浏览器的 ProgId。
 * 用「stdout 重定向到文件」而不是管道：在 DSH 的命令沙箱下，管道会 EPERM。
 * 读不到（非 Windows / 注册表被锁 / 没有 ProgId）时返回 null，由调用方回退。
 */
export function defaultBrowserProgId() {
  if (!IS_WIN) return null;
  const tmp = path.join(
    os.tmpdir(),
    `dsh-owa-progid-${process.pid}-${Math.random().toString(36).slice(2)}.txt`,
  );
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    spawnSync('reg.exe', ['query', URL_ASSOC_KEY, '/v', 'ProgId'], {
      stdio: ['ignore', fd, 'ignore'],
      windowsHide: true,
      timeout: 5000,
    });
    fs.closeSync(fd);
    fd = null;
    const out = fs.readFileSync(tmp, 'utf8');
    const m = /ProgId\s+REG_SZ\s+(\S+)/.exec(out);
    return m ? m[1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function keyForProgId(progId) {
  if (!progId) return null;
  for (const [re, key] of PROGID_RULES) if (re.test(progId)) return key;
  return null;
}

function firstExisting(list) {
  for (const p of list) if (p && fs.existsSync(p)) return p;
  return null;
}

/** 探测结果：{ progId, key, exe }，不抛错。 */
export function detect() {
  const progId = defaultBrowserProgId();
  const key = keyForProgId(progId);
  const exe = key ? firstExisting(CANDIDATES[key]) : null;
  return { progId, key, exe };
}

/**
 * 解析要用的浏览器 exe。
 * @param {string} [configured] 配置值；空 / 'auto' 表示自动
 * @returns {{exe: string, source: string, progId: string|null, key: string|null}}
 */
export function resolveBrowser(configured) {
  const want = String(configured || '').trim();
  const auto = !want || want.toLowerCase() === 'auto';

  if (!auto) {
    if (fs.existsSync(want)) return { exe: want, source: '配置指定', progId: null, key: null };
    // 配错了也别把人卡死：能自动找到就照用，并在 source 里说明
    const autoPick = autoDetect();
    if (autoPick) {
      return {
        ...autoPick,
        source: `${autoPick.source}（配置的路径不存在，已忽略：${want}）`,
      };
    }
    throw new Error(
      `配置的浏览器不存在：${want}，自动检测也没找到 Chromium 系浏览器。` +
        '请安装 Chrome 或 Edge，或把 edgePath 改成正确的 exe 路径。',
    );
  }

  const picked = autoDetect();
  if (picked) return picked;
  throw new Error(
    '没有找到可用的 Chromium 系浏览器（Chrome / Edge / Brave / Vivaldi / Opera / Chromium 都没找到）。' +
      '默认浏览器若是 Firefox 这类非 Chromium 内核，本插件无法驱动它；装一个 Chrome 或 Edge 即可，装完不需要改任何配置。',
  );
}

function autoDetect() {
  if (!IS_WIN) {
    // macOS/Linux：靠 edgePath 显式指定
    return null;
  }
  const { progId, key, exe } = detect();
  if (key && exe) {
    return { exe, source: `默认浏览器 ${progId}`, progId, key };
  }
  for (const k of FALLBACK_ORDER) {
    const hit = firstExisting(CANDIDATES[k]);
    if (hit) {
      const why = progId
        ? `默认浏览器 ${progId} 不是 Chromium 系`
        : '读不到默认浏览器设置';
      return { exe: hit, source: `已安装的 ${LABEL[k]}（${why}）`, progId, key: k };
    }
  }
  return null;
}
