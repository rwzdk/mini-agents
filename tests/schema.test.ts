import { describe, expect, it } from 'vitest';
import { defineTool, validateArgs } from '../src/schema.js';

const schema = {
  type: 'object' as const,
  properties: {
    query: { type: 'string' as const, description: '关键词' },
    limit: { type: 'number' as const },
    deep: { type: 'boolean' as const },
    tags: { type: 'array' as const },
  },
  required: ['query'],
};

describe('validateArgs', () => {
  it('合法参数通过', () => {
    expect(validateArgs(schema, { query: 'rag', limit: 3 })).toBeNull();
  });

  it('缺少必填参数报错', () => {
    expect(validateArgs(schema, {})).toContain('query');
  });

  it('类型不匹配报错', () => {
    expect(validateArgs(schema, { query: 'ok', limit: '三个' })).toContain('limit');
    expect(validateArgs(schema, { query: 'ok', deep: 'yes' })).toContain('deep');
    expect(validateArgs(schema, { query: 'ok', tags: 'a,b' })).toContain('tags');
  });

  it('未声明的多余字段不报错（宽容策略）', () => {
    expect(validateArgs(schema, { query: 'ok', extra: 1 } as never)).toBeNull();
  });

  it('值为 null / undefined 的边界', () => {
    expect(validateArgs(schema, { query: null as never })).toContain('query');
    expect(validateArgs(schema, { query: 'ok', limit: undefined } as never)).toBeNull();
  });
});

describe('defineTool', () => {
  it('拒绝非法工具名', () => {
    expect(() =>
      defineTool({
        name: '1bad-name!',
        description: '',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({}),
      }),
    ).toThrow();
  });

  it('拒绝非 object 的参数 schema', () => {
    expect(() =>
      defineTool({
        name: 'ok_tool',
        description: '',
        parameters: { type: 'string' } as never,
        execute: async () => ({}),
      }),
    ).toThrow();
  });

  it('同步 execute 也可以定义', async () => {
    const tool = defineTool({
      name: 'sync_tool',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ ok: true }),
    });
    expect(await tool.execute({})).toEqual({ ok: true });
  });
});
