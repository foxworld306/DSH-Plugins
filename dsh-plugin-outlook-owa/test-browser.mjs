/**
 * 浏览器探测自测：node test-browser.mjs
 *
 * 打印默认浏览器 ProgId、实际选中的 Chromium 浏览器，以及几种配置值下的解析结果。
 * 换机器（尤其同事的机器默认浏览器不是 Edge 时）跑一次，就能确诊插件会拉起哪个窗口。
 */
import { defaultPort, defaultProfileDir, detect, resolveBrowser } from './src/browser.js';

const line = (s) => console.log(s);

line('== Windows 默认浏览器 ==');
const d = detect();
line(`  ProgId      : ${d.progId ?? '(读不到)'}`);
line(`  映射内核     : ${d.key ?? '(非 Chromium 系 / 未知)'}`);
line(`  该品牌 exe   : ${d.exe ?? '(未找到)'}`);

line('\n== 解析结果 ==');
for (const [label, value] of [
  ['auto（默认）', 'auto'],
  ['空值', ''],
  ['显式路径（存在）', d.exe || ''],
  ['显式路径（不存在）', 'C:\\nope\\chrome.exe'],
]) {
  try {
    const r = resolveBrowser(value);
    line(`  ${label.padEnd(18)} -> ${r.exe}`);
    line(`  ${' '.repeat(18)}    ${r.source}`);
  } catch (e) {
    line(`  ${label.padEnd(18)} -> 抛错：${e.message}`);
  }
}

line('\n== 运行参数 ==');
line(`  CDP 端口     : ${defaultPort()}`);
line(`  登录 profile : ${defaultProfileDir()}`);
