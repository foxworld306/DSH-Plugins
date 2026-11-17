#!/usr/bin/env node
/**
 * dsh-kb-query — 一把梭发布打包：注入 → npm pack → 无论如何都还原。
 *
 *   node scripts/release-pack.mjs            # 产出 dsh-kb-query-<version>.tgz
 *   node scripts/release-pack.mjs --publish  # 同上，但改为 npm publish
 *
 * 与 package.json 的 `prepack` / `postpack` 钩子二选一即可：
 *  - `npm pack` / `npm publish` 直接用钩子（依赖 npm 会跑生命周期脚本）；
 *  - 需要"注入后一定还原"的强保证时用本脚本（try/finally，即使 pack 失败也还原）。
 *
 * 注意：某些环境会设置 npm_config_ignore_scripts=true，那会跳过 prepack/postpack，
 * 此时请使用本脚本（它显式调用注入，并给 npm 传 --ignore-scripts 避免重复注入）。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const injectScript = path.join(root, "scripts", "inject-kb-secrets.mjs");
const publish = process.argv.includes("--publish");

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
};

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

let injected = false;
try {
  run(process.execPath, [injectScript, "inject"]);
  injected = true;
  run(npm, [publish ? "publish" : "pack", "--ignore-scripts"], { shell: process.platform === "win32" });
} finally {
  if (injected) {
    try {
      run(process.execPath, [injectScript, "restore"]);
    } catch (error) {
      console.error(`⚠️ 还原失败，请手动执行：node scripts/inject-kb-secrets.mjs restore`);
      console.error(error?.message ?? error);
      process.exitCode = 1;
    }
  }
}
