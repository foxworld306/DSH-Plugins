/**
 * 本地 defineTool 垫片（零依赖）。
 *
 * 为什么不 import @deepseek-ai/dsh-tools：
 * 那会把整套框架包带进用户 profile，与宿主自带的一份形成双实例，
 * 导致注册表里取到另一份的对象，运行期报 "Cannot read properties of undefined
 * (reading 'prepare')"。这里只复刻它对注册表的契约：
 *   { name, description, parameters: <JSON Schema>, output: { schema, render }, execute }
 * 其中 parameters 由下面这个简写编译器生成（与框架的
 * parameterSchemaSpecToJsonSchema 等价）。
 */

/**
 * 把 `{ 名称: { type, required?, description? } }` 编译成 JSON Schema。
 * @param {Record<string, {required?: boolean}>} spec
 * @returns {object} 以 object 为根的 JSON Schema
 */
export function compileParameters(spec = {}) {
  const properties = {};
  const required = [];
  for (const [key, raw] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = raw || {};
    properties[key] = rest;
    if (isRequired) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * 生成一个可交给 ctx.tools.register() 的工具定义。
 * 与框架唯一的差别是：不做额外的类型推导，一切照传。
 */
export function defineTool(options) {
  const { parameters = {}, output, execute, name, description, timeoutMs } = options;
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('defineTool: name 必须是非空字符串');
  if (typeof execute !== 'function') throw new TypeError(`defineTool(${name}): execute 必须是函数`);
  if (!output || typeof output.render !== 'function' || output.schema === undefined) {
    throw new TypeError(`defineTool(${name}): 必须声明 output { schema, render }`);
  }
  return {
    name,
    description: description || '',
    parameters: compileParameters(parameters),
    output: { schema: output.schema, render: output.render },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    execute,
  };
}
