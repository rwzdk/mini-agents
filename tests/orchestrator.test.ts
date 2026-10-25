import { describe, expect, it } from 'vitest';
import { pipeline, runFlowToEnd, supervisor } from '../src/orchestrator.js';
import type { ChatMessage, LlmClient, LlmResponse, ToolDefinition } from '../src/types.js';

function fnClient(
  impl: (messages: ChatMessage[], tools?: ToolDefinition[], call: number) => LlmResponse,
): LlmClient & { callCount: () => number; seen: ChatMessage[][] } {
  let n = 0;
  const seen: ChatMessage[][] = [];
  return {
    callCount: () => n,
    seen,
    async chat(messages, tools) {
      n++;
      seen.push([...messages]);
      return impl(messages, tools, n);
    },
  };
}

describe('pipeline', () => {
  it('前一个 Agent 的输出作为下一个的输入', async () => {
    const client = fnClient((_msgs, _tools, call) => {
      if (call === 1) return { content: '第一手研究结论', toolCalls: [], finishReason: 'stop' };
      return { content: '已改写：' + '第一手研究结论', toolCalls: [], finishReason: 'stop' };
    });
    const { output, events } = await runFlowToEnd(
      pipeline({
        agents: [
          { name: 'researcher', instructions: '' },
          { name: 'writer', instructions: '' },
        ],
        input: '原始任务',
        client,
      }),
    );
    expect(output).toBe('已改写：第一手研究结论');
    // 第二个 agent 收到的 user 消息是第一个的输出
    const secondInput = client.seen[1].find((m) => m.role === 'user');
    expect(secondInput && 'content' in secondInput && secondInput.content).toBe('第一手研究结论');
    expect(events.filter((e) => e.type === 'agent-end')).toHaveLength(2);
    expect(events[events.length - 1]).toMatchObject({ type: 'flow-end', flow: 'pipeline' });
  });
});

describe('supervisor', () => {
  const workers = [
    { name: 'translator', instructions: '中英互译。' },
    { name: 'calculator', instructions: '算数。' },
  ];

  it('router 委派 worker 并用 finish 汇总', async () => {
    const client = fnClient((messages, _tools, call) => {
      if (call === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'd1', name: 'delegate', args: { worker: 'translator', task: '翻译 hello' } }],
          finishReason: 'tool_calls',
        };
      }
      if (call === 2) {
        // worker（translator）的调用
        return { content: '你好', toolCalls: [], finishReason: 'stop' };
      }
      return {
        content: '',
        toolCalls: [{ id: 'f1', name: 'finish', args: { answer: '最终：你好' } }],
        finishReason: 'tool_calls',
      };
    });
    const { output, events } = await runFlowToEnd(
      supervisor({
        router: { name: 'router', instructions: '主管' },
        workers,
        input: '翻译 hello',
        client,
      }),
    );
    expect(output).toBe('最终：你好');
    // worker 的产出事件也在流里
    expect(events.some((e) => e.type === 'agent-end' && e.agent === 'translator')).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ type: 'flow-end', flow: 'supervisor' });
  });

  it('委派未知工人时把可用清单回传给 router', async () => {
    const client = fnClient((_m, _t, call) => {
      if (call === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'd1', name: 'delegate', args: { worker: '幽灵', task: 'x' } }],
          finishReason: 'tool_calls',
        };
      }
      return {
        content: '',
        toolCalls: [{ id: 'f1', name: 'finish', args: { answer: '改好了' } }],
        finishReason: 'tool_calls',
      };
    });
    const { events } = await runFlowToEnd(
      supervisor({
        router: { name: 'router', instructions: '' },
        workers,
        input: 'x',
        client,
      }),
    );
    const delegateResult = events.find((e) => e.type === 'tool-result' && (e as { tool: string }).tool === 'delegate') as unknown as { result: { error?: string } };
    expect(delegateResult.result.error).toContain('未知工人');
  });

  it('router 直接输出文本（未调用 finish）也视为结束', async () => {
    const client = fnClient(() => ({ content: '直接回答', toolCalls: [], finishReason: 'stop' }));
    const { output } = await runFlowToEnd(
      supervisor({
        router: { name: 'router', instructions: '' },
        workers,
        input: 'x',
        client,
      }),
    );
    expect(output).toBe('直接回答');
  });

  it('超过 maxRounds 强制结束', async () => {
    const client = fnClient(() => ({
      content: '',
      toolCalls: [{ id: 'd', name: 'delegate', args: { worker: 'translator', task: 'x' } }],
      finishReason: 'tool_calls',
    }));
    const workerCall = (messages: ChatMessage[]) => String(messages.find((m) => m.role === 'user')?.content ?? '');
    const impl = client.chat.bind(client);
    client.chat = async (messages, tools) => {
      const isWorker = messages.some((m) => m.role === 'system' && m.content === '中英互译。');
      if (isWorker) {
        return { content: `完成 ${workerCall(messages)}`, toolCalls: [], finishReason: 'stop' };
      }
      return impl(messages, tools);
    };
    const { events } = await runFlowToEnd(
      supervisor({
        router: { name: 'router', instructions: '' },
        workers,
        input: 'x',
        client,
        maxRounds: 2,
      }),
    );
    expect(client.callCount()).toBeLessThanOrEqual(5); // 2 轮 router 委派 + 2 次 worker + 收尾判断
    expect(events.some((e) => e.type === 'agent-error')).toBe(false);
  });
});
