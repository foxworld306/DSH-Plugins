/**
 * dsh-kb-query — 当前身份（企业邮箱）解析。
 *
 * 设计原则：
 *  - 身份来自"机器/票据"，**永不**来自请求入参、模型参数或 /kb* 请求体；
 *  - 顺序固定，逐级降级，任何异常都落到 `unresolved`（调用方据此 fail closed）；
 *  - 纯逻辑 + 注入式读取器（`read`），便于单元测试在没有注册表的环境里跑。
 *
 * 解析顺序（M1 → M2）：
 *   1. `SUEZ_USER_EMAIL`            —— M2：连接器从 SSO 票据注入（首选）
 *   2. `config.identityEmail`       —— 运维兜底（单机手工指定）
 *   3. OneDrive 注册表 UserEmail    —— 例如 rio.zhao@suez.com
 *   4. Office 注册表 ADUserName     —— 例如 riozhao@suez-asia.local
 *   5. unresolved                   —— 只给静态白名单（不给任何个人库）
 */

import { execFileSync } from "node:child_process";

/** 身份来源标签（设置页直接展示，便于用户核对）。 */
export const IDENTITY_SOURCES = Object.freeze({
  ENV: "env",
  CONFIG: "config",
  ONEDRIVE: "onedrive",
  OFFICE: "office",
  UNRESOLVED: "unresolved",
});

const ONEDRIVE_KEY = "HKCU\\Software\\Microsoft\\OneDrive\\Accounts\\Business1";
const OFFICE_KEY = "HKCU\\Software\\Microsoft\\Office\\16.0\\Common\\Identity";
/** 保守的邮箱形状校验：宽松到能容纳国际域名，严格到拒绝路径/空白。 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @param {unknown} value @returns {boolean} */
export function looksLikeEmail(value) {
  return typeof value === "string" && EMAIL_RE.test(value.trim());
}

/**
 * 默认注册表读取器：`reg.exe query <key> /v <name>`（2000ms 超时，失败返回 undefined）。
 * 只读 HKCU，不需要管理员权限。
 * @param {string} keyPath
 * @param {string} valueName
 * @returns {string | undefined}
 */
export function readRegistryValue(keyPath, valueName) {
  try {
    const out = execFileSync("reg.exe", ["query", keyPath, "/v", valueName], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    });
    for (const raw of String(out).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith(valueName)) continue;
      // 形如: "    UserEmail    REG_SZ    rio.zhao@suez.com"
      const parts = line.split(/\s{2,}/);
      const value = (parts[parts.length - 1] ?? "").trim();
      if (value !== "") return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {object} [options]
 * @param {{identityEmail?: string}} [options.config] 插件配置（只用 identityEmail）
 * @param {NodeJS.ProcessEnv} [options.env] 进程环境（读 SUEZ_USER_EMAIL）
 * @param {(keyPath: string, valueName: string) => string | undefined} [options.read]
 * @param {number} [options.cacheMs] 解析结果缓存（默认 5 分钟）
 * @param {{warn?: Function}} [options.log]
 * @returns {{ resolve: () => Promise<{email: string | undefined, source: string}>, clear: () => void }}
 */
export function makeIdentityResolver({ config = {}, env = process.env, read = readRegistryValue, cacheMs = 300_000, log } = {}) {
  /** @type {{at: number, value: {email: string | undefined, source: string}} | undefined} */
  let cache;

  /** @returns {{email: string | undefined, source: string}} */
  function compute() {
    const fromEnv = env?.SUEZ_USER_EMAIL;
    if (looksLikeEmail(fromEnv)) return { email: fromEnv.trim(), source: IDENTITY_SOURCES.ENV };

    if (looksLikeEmail(config?.identityEmail)) {
      return { email: config.identityEmail.trim(), source: IDENTITY_SOURCES.CONFIG };
    }

    const oneDrive = read(ONEDRIVE_KEY, "UserEmail");
    if (looksLikeEmail(oneDrive)) return { email: oneDrive.trim(), source: IDENTITY_SOURCES.ONEDRIVE };

    const office = read(OFFICE_KEY, "ADUserName");
    if (looksLikeEmail(office)) return { email: office.trim(), source: IDENTITY_SOURCES.OFFICE };

    return { email: undefined, source: IDENTITY_SOURCES.UNRESOLVED };
  }

  return {
    async resolve() {
      const now = Date.now();
      if (cache !== undefined && now - cache.at < cacheMs) return cache.value;
      let value;
      try {
        value = compute();
      } catch {
        value = { email: undefined, source: IDENTITY_SOURCES.UNRESOLVED };
      }
      if (value.email === undefined) {
        log?.warn?.("kb: identity unresolved (no SUEZ_USER_EMAIL / identityEmail / OneDrive / Office email) — personal KBs stay off");
      }
      cache = { at: now, value };
      return value;
    },
    clear() {
      cache = undefined;
    },
  };
}
