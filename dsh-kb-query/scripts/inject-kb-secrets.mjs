#!/usr/bin/env node
/**
 * dsh-kb-query — 发布期密钥注入（仓库里永远保持占位符）。
 *
 * 用法：
 *   node scripts/inject-kb-secrets.mjs inject     # 把 env 里的真实值写入 cordis.patch.yml
 *   node scripts/inject-kb-secrets.mjs restore    # 从备份还原（默认在 npm pack 之后自动调用）
 *   node scripts/inject-kb-secrets.mjs check      # 发布前守卫：仓库文件必须仍是占位符（空值）
 *
 * 输入（环境变量，绝不落盘到仓库文件之外的地方）：
 *   KB_PG_URL          必填，形如 postgres://kb_readonly:***@host:5432/powergpt
 *   KB_EMBED_API_KEY   必填，嵌入 / rerank 网关 key（同一把 key 同时服务两段）
 *
 * 行为要点：
 *  - 只改 `- id: kb-query` 行内的 `pgUrl:` 与 `rerankApiKey:` 两个标量，其余字节（含注释）不动；
 *  - 首次注入前把原文件复制为 `cordis.patch.yml.injected-backup`（.gitignore 已忽略）；
 *  - `restore` 幂等：备份不存在就什么也不做；
 *  - 日志里的值全部打码（DSN 只显示 user@host/db，key 只显示前后 4 位）。
 */

import { readFile, writeFile, copyFile, access, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "cordis.patch.yml");
const backup = path.join(root, "cordis.patch.yml.injected-backup");

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

/** YAML 双引号标量：JSON 字符串转义与其兼容（值只含 URL / ASCII key）。 */
const yamlString = (value) => JSON.stringify(value);

function maskDsn(dsn) {
  return String(dsn).replace(/^(\w+:\/\/)([^:]+):([^@]*)@/, (_m, scheme, user) => `${scheme}${user}:***@`);
}

function maskKey(key) {
  const s = String(key);
  if (s.length <= 10) return `${s.slice(0, 2)}***`;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${name} is required.\n` +
        `  PowerShell: $env:${name} = "..."\n` +
        `  bash:       export ${name}=...\n` +
        `  源：公司 policy / 密钥库（不要把真实值提交进本仓库）`
    );
  }
  return value.trim();
}

/** 把两个键的值替换成给定值（要求每个键恰好出现一次）。 */
function withInjectedValues(text, { pgUrl, rerankApiKey }) {
  if (!/-\s*id:\s*kb-query/.test(text)) throw new Error("cordis.patch.yml has no `- id: kb-query` row");
  let out = text;
  for (const [key, value] of [
    ["pgUrl", pgUrl],
    ["rerankApiKey", rerankApiKey],
  ]) {
    const re = new RegExp(`^(\\s*)${key}:[^\\n]*$`, "m");
    const hits = [...out.matchAll(new RegExp(re.source, "gm"))];
    if (hits.length !== 1) throw new Error(`cordis.patch.yml: expected exactly one \`${key}:\` line, found ${hits.length}`);
    out = out.replace(re, (_all, indent) => `${indent}${key}: ${yamlString(value)}`);
  }
  return out;
}

/** 读取当前文件里两个键的值（用于 check / status）。 */
function readValues(text) {
  const pick = (key) => {
    const m = text.match(new RegExp(`^\\s*${key}:[^\\n]*$`, "m"));
    if (!m) return undefined;
    const raw = m[0].slice(m[0].indexOf(":") + 1).trim();
    if (raw === "" || raw === '""' || raw === "''") return "";
    return raw.replace(/^["']|["']$/g, "");
  };
  return { pgUrl: pick("pgUrl"), rerankApiKey: pick("rerankApiKey") };
}

async function cmdInject() {
  const pgUrl = requireEnv("KB_PG_URL");
  const rerankApiKey = requireEnv("KB_EMBED_API_KEY");
  if (!/^postgres(ql)?:\/\//.test(pgUrl)) throw new Error("KB_PG_URL must start with postgres:// or postgresql://");
  if (rerankApiKey.length < 8) throw new Error("KB_EMBED_API_KEY looks too short");
  if (!/\/\/kb_readonly:/.test(pgUrl)) {
    console.warn(
      "⚠️  KB_PG_URL 用的不是 kb_readonly 只读账号 —— 等于把数据库的更高权限发给每台装了插件的机器。建议改用 m0/kb_readonly.sql 创建的角色。"
    );
  }

  const text = await readFile(target, "utf8");
  if (!(await exists(backup))) await copyFile(target, backup);
  await writeFile(target, withInjectedValues(text, { pgUrl, rerankApiKey }), "utf8");
  console.log(`injected: pgUrl=${maskDsn(pgUrl)}  rerankApiKey=${maskKey(rerankApiKey)}`);
  console.log(`backup:   ${path.basename(backup)}（restore 可还原）`);
}

async function cmdRestore() {
  if (!(await exists(backup))) {
    console.log("nothing to restore (no injected backup)");
    return;
  }
  await copyFile(backup, target);
  await rm(backup, { force: true });
  console.log("restored cordis.patch.yml from the pre-injection backup");
}

async function cmdCheck() {
  const text = await readFile(target, "utf8");
  const { pgUrl, rerankApiKey } = readValues(text);
  const problems = [];
  if (pgUrl === undefined) problems.push("pgUrl key missing");
  else if (pgUrl !== "") problems.push("pgUrl still holds a value — secrets must not be committed");
  if (rerankApiKey === undefined) problems.push("rerankApiKey key missing");
  else if (rerankApiKey !== "") problems.push("rerankApiKey still holds a value — secrets must not be committed");
  if (await exists(backup)) problems.push("cordis.patch.yml.injected-backup exists (an injection was not restored)");
  if (problems.length > 0) {
    console.error("❌ commit guard failed:\n  - " + problems.join("\n  - "));
    process.exitCode = 1;
    return;
  }
  console.log("✅ cordis.patch.yml is clean (placeholders only)");
}

async function cmdStatus() {
  const text = await readFile(target, "utf8");
  const { pgUrl, rerankApiKey } = readValues(text);
  console.log(`pgUrl:        ${pgUrl === "" ? "(placeholder)" : maskDsn(pgUrl)}`);
  console.log(`rerankApiKey: ${rerankApiKey === "" ? "(placeholder)" : maskKey(rerankApiKey)}`);
  console.log(`backup:       ${(await exists(backup)) ? "present" : "absent"}`);
}

const command = (process.argv[2] ?? "inject").toLowerCase();
const commands = { inject: cmdInject, restore: cmdRestore, check: cmdCheck, status: cmdStatus };
if (!commands[command]) {
  console.error(`unknown command: ${command}\nusage: inject | restore | check | status`);
  process.exitCode = 2;
} else {
  try {
    await commands[command]();
  } catch (error) {
    console.error(`❌ ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
