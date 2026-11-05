/**
 * 本地冒烟测试：不经过 DSH，直接加载插件并校验注册契约。
 * 用法：node test-smoke.mjs [toolName]   （参数放 $env:ARGS，JSON）
 * 首次运行前先 `npm install`（装 schemastery 依赖）。
 */
import { apply } from './src/index.js';
import { resolveRange, nowContext } from './src/time.js';

const registered = new Map();
const ctx = { tools: { register: (t) => registered.set(t.name, t) } };

apply(ctx, {});

console.log('== 已注册工具 ==');
console.log([...registered.keys()].join(', '));

console.log('\n== 注册契约校验 ==');
let bad = 0;
for (const [name, tool] of registered) {
  const problems = [];
  if (typeof tool.name !== 'string' || !tool.name) problems.push('name');
  if (typeof tool.description !== 'string' || !tool.description) problems.push('description');
  if (!tool.parameters || tool.parameters.type !== 'object') problems.push('parameters.type=object');
  if (!tool.parameters || typeof tool.parameters.properties !== 'object') problems.push('parameters.properties');
  if (!tool.output || typeof tool.output.render !== 'function') problems.push('output.render');
  if (!tool.output || typeof tool.output.schema !== 'object') problems.push('output.schema');
  if (typeof tool.execute !== 'function') problems.push('execute');
  if (problems.length) { bad++; console.log(`  x ${name}: ${problems.join(', ')}`); }
}
console.log(bad === 0 ? `  ok ${registered.size} 个工具全部符合契约` : `  x ${bad} 个工具不合规`);

const only = process.argv[2];
if (only) {
  const tool = registered.get(only);
  if (!tool) {
    console.error('未注册的工具: ' + only);
    process.exit(1);
  }
  const args = process.env.ARGS ? JSON.parse(process.env.ARGS) : {};
  console.log(`\n== ${only} ==`);
  console.log(await tool.execute(args, { signal: { aborted: false } }));
  process.exit(bad === 0 ? 0 : 1);
}

console.log('\n== 时间解析 ==');
const now = nowContext();
console.log(`${now.human} ${now.weekday} ${now.timeZone} ${now.utcOffset}`);
for (const spec of ['today', '昨天下午', 'this_week', '本季度', '今年']) {
  const r = resolveRange(spec);
  console.log(`  ${String(spec).padEnd(10)} -> ${r.label}`);
}

console.log('\n== outlook_owa_now ==');
console.log(await registered.get('outlook_owa_now').execute({}, { signal: { aborted: false } }));
process.exit(bad === 0 ? 0 : 1);
