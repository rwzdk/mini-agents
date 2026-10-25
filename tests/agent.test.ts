import { describe, expect, it } from 'vitest';
import { runAgent, runAgentToEnd } from '../src/agent.js';
import { defineTool } from '../src/schema.js';
import type { ChatMessage, JsonObject, LlmClient, LlmResponse, ToolDefinition } from '../src/types.js';

/** 脚本化客户端：按顺序返回预设响应，也可用函数根据 messages 动态断言 */
function scripted(responses: (LlmResponse | ((messages: ChatMessage[], tools?: ToolDefinition[]) => LlmResponse))[]): LlmClient & { calls: { messages: ChatMessage[]; tools?: ToolDefinition[] }[] } {
  const calls: { messages: ChatMessage[]; tools?: ToolDefinition[] }[] = [];
  let i = 0;
  return {
    calls,
    async chat(messages, tools) {
      calls.push({ messages: [...messages], tools });
      if (i >= responses.length) throw new Error('脚本响应已耗尽');
      const next = responses[i++];
      return typeof next === 'function' ? next(messages, tools) : next;
    },
  };
}

const calc = defineTool({
  name: 'calc',
  description: '计算 a*b',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  execute: async ({ a, b }) => ({ value: Number(a) * Number(b) }),
});

describe('runAgent 工具循环', () => {
  it('调用工具后基于结果作答', async () => {
    const client = scripted([
      { content: '', toolCalls: [{ id: 'c1', name: 'calc', args: { a: 6, b: 7 } }], finishReason: 'tool_calls' },
      { content: '6 × 7 = 42', toolCalls: [], finishReason: 'stop' },
    ]);
    const result = await runAgentToEnd({
      agent: { name: 'math', instructions: '计算器助手', tools: [calc] },
      input: '6 乘 7 等于几？',
      client,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe('6 × 7 = 42');
    expect(result.toolRounds).toBe(1);

    const types = result.events.map((e) => e.type);
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-result');
    // 工具结果以 role:tool 消息回传给模型
    const toolMsg = client.calls[1].messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(JSON.parse((toolMsg as { content: string }).content).value).toBe(42);
  });

  it('未知工具与参数校验失败不中断循环，错误回传模型', async () => {
    const client = scripted([
      { content: '', toolCalls: [{ id: 'x1', name: 'not_exist', args: {} }], finishReason: 'tool_calls' },
      {
        content: '',
        toolCalls: [{ id: 'x2', name: 'calc', args: { a: '不是数字', b: 2 } as unknown as JsonObject }],
        finishReason: 'tool_calls',
      },
      { content: '工具不可用，我直接心算：14', toolCalls: [], finishReason: 'stop' },
    ]);
    const result = await runAgentToEnd({
      agent: { name: 'math', instructions: '计算器助手', tools: [calc] },
      input: '7 乘 2？',
      client,
    });
    expect(result.output).toContain('心算');
    const toolResults = result.events.filter((e) => e.type === 'tool-result') as { result: JsonObject }[];
    expect(toolResults[0].result.error).toContain('未知工具');
    expect(toolResults[1].result.error).toContain('参数校验失败');
  });

  it('工具 execute 抛错时返回错误对象而非中断', async () => {
    const boom = defineTool({
      name: 'boom',
      description: '总是失败',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        throw new Error('炸了');
      },
    });
    const client = scripted([
      { content: '', toolCalls: [{ id: 'b1', name: 'boom', args: {} }], finishReason: 'tool_calls' },
      { content: '工具坏了', toolCalls: [], finishReason: 'stop' },
    ]);
    const result = await runAgentToEnd({
      agent: { name: 'a', instructions: '', tools: [boom] },
      input: 'x',
      client,
    });
    const ev = result.events.find((e) => e.type === 'tool-result') as { result: JsonObject };
    expect(ev.result.error).toContain('炸了');
    expect(result.ok).toBe(true);
  });

  it('达到 maxSteps 后收走工具，强制文本收尾', async () => {
    const client = scripted([
      { content: '', toolCalls: [{ id: '1', name: 'calc', args: { a: 1, b: 1 } }], finishReason: 'tool_calls' },
      { content: '', toolCalls: [{ id: '2', name: 'calc', args: { a: 2, b: 2 } }], finishReason: 'tool_calls' },
      { content: '被迫总结：计算完成', toolCalls: [], finishReason: 'stop' },
    ]);
    const result = await runAgentToEnd({
      agent: { name: 'loop', instructions: '', tools: [calc], maxSteps: 2 },
      input: 'x',
      client,
    });
    expect(result.toolRounds).toBe(2);
    expect(result.output).toBe('被迫总结：计算完成');
    // 第三次调用不再携带工具
    expect(client.calls[2].tools).toBeUndefined();
  });

  it('LLM 异常产生 agent-error 事件', async () => {
    const events: string[] = [];
    for await (const ev of runAgent({
      agent: { name: 'bad', instructions: '' },
      input: 'x',
      client: { chat: async () => Promise.reject(new Error('网络炸了')) },
    })) {
      events.push(ev.type);
    }
    expect(events).toContain('agent-error');
    expect(events).not.toContain('agent-end');
  });
});
