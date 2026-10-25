import type { JsonObject, JsonSchema, ToolDefinition } from './types.js';

const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

type DefineToolInput = {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (args: JsonObject) => Promise<JsonObject> | JsonObject;
};

/** 定义工具：校验名称与 schema 形状，execute 支持同步/异步 */
export function defineTool(input: DefineToolInput): ToolDefinition {
  if (!TOOL_NAME_RE.test(input.name)) {
    throw new Error(`工具名不合法：${input.name}（需匹配 ${TOOL_NAME_RE}）`);
  }
  if (input.parameters.type !== 'object' || typeof input.parameters.properties !== 'object') {
    throw new Error(`工具 ${input.name} 的 parameters 必须是 type:"object" 的 JSON Schema`);
  }
  return {
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    execute: async (args) => input.execute(args),
  };
}

/**
 * 参数校验（JSON Schema 极简子集）：required 必须存在，类型必须匹配。
 * 返回错误消息；通过时返回 null。校验失败不会抛异常——而是作为工具错误结果回给模型，让它自行纠正。
 */
export function validateArgs(schema: JsonSchema, args: JsonObject): string | null {
  for (const key of schema.required ?? []) {
    if (!(key in args)) return `缺少必填参数 "${key}"`;
  }
  for (const [key, rule] of Object.entries(schema.properties)) {
    const value = args[key];
    if (value === undefined) continue;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    const expected = rule.type;
    const ok =
      (expected === 'array' && actual === 'array') ||
      (expected === 'object' && actual === 'object') ||
      (expected === 'string' && actual === 'string') ||
      (expected === 'number' && actual === 'number') ||
      (expected === 'boolean' && actual === 'boolean');
    if (!ok) {
      return `参数 "${key}" 期望 ${expected}，实际 ${actual === 'object' ? 'object' : actual}`;
    }
  }
  return null;
}
