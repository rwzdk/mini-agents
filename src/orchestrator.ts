import type { AgentDefinition, ChatMessage, FlowEvent, LlmClient, ToolCall } from './types.js';
import { defineTool } from './schema.js';
import { runAgent, runAgentToEnd } from './agent.js';

/**
 * pipeline：串行流水线——前一个 Agent 的输出作为下一个 Agent 的输入。
 * 典型用法：researcher（带工具）→ writer（纯生成）。
 */
export async function* pipeline(options: {
  agents: AgentDefinition[];
  input: string;
  client: LlmClient;
}): AsyncGenerator<FlowEvent> {
  let current = options.input;
  for (const agent of options.agents) {
    for await (const event of runAgent({ agent, input: current, client: options.client })) {
      if (event.type === 'agent-end') current = event.output;
      yield event;
    }
  }
  yield { type: 'flow-end', flow: 'pipeline', output: current };
}

/**
 * supervisor：主管模式——router 决定把任务 delegate 给哪个 worker，
 * 汇总 worker 结果，最终用 finish 给出答案（或由 maxRounds 强制收尾）。
 * router 的 delegate/finish 是由本函数注入的元工具，worker 完成结果会回传给 router。
 */
export async function* supervisor(options: {
  router: AgentDefinition;
  workers: AgentDefinition[];
  input: string;
  client: LlmClient;
  /** 委派轮数上限，默认 6 */
  maxRounds?: number;
}): AsyncGenerator<FlowEvent> {
  const { router, workers, client } = options;
  const maxRounds = options.maxRounds ?? 6;
  const roster = workers.map((w) => `- ${w.name}: ${w.instructions.split('\n')[0].slice(0, 80)}`).join('\n');

  const delegate = defineTool({
    name: 'delegate',
    description: '把一项具体任务交给指定的工人执行',
    parameters: {
      type: 'object',
      properties: {
        worker: { type: 'string', description: '工人名称' },
        task: { type: 'string', description: '交给工人的具体任务描述' },
      },
      required: ['worker', 'task'],
    },
    execute: async () => ({}),
  });
  const finish = defineTool({
    name: 'finish',
    description: '全部完成后，给出面向用户的最终答案',
    parameters: {
      type: 'object',
      properties: { answer: { type: 'string', description: '最终答案' } },
      required: ['answer'],
    },
    execute: async () => ({}),
  });

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        `${router.instructions}\n\n你可以指挥以下工人：\n${roster}\n\n` +
        '规则：用 delegate 工具把具体任务交给最合适的工人；拿到结果后如需继续再委派；' +
        '全部完成后必须用 finish 工具给出最终答案。',
    },
    { role: 'user', content: options.input },
  ];

  let round = 0;
  let output = '';
  yield { type: 'agent-start', agent: router.name, input: options.input };

  try {
    outer: while (true) {
      round++;
      if (round > maxRounds) {
        output += output ? '\n（已达最大委派轮数，强制结束）' : '（已达最大委派轮数，强制结束）';
        break;
      }
      const res = await client.chat(messages, [delegate, finish]);
      messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
      if (res.toolCalls.length === 0) {
        output = res.content;
        break;
      }
      for (const call of res.toolCalls as ToolCall[]) {
        yield { type: 'tool-call', agent: router.name, tool: call.name, args: call.args };
        if (call.name === 'finish') {
          output = typeof call.args.answer === 'string' ? call.args.answer : res.content;
          yield { type: 'tool-result', agent: router.name, tool: 'finish', result: { done: true } };
          break outer;
        }
        if (call.name === 'delegate') {
          const workerName = String(call.args.worker ?? '');
          const task = String(call.args.task ?? '');
          const worker = workers.find((w) => w.name === workerName);
          let resultText: string;
          if (!worker) {
            resultText = `未知工人：${workerName}。可用：${workers.map((w) => w.name).join(', ')}`;
            yield { type: 'tool-result', agent: router.name, tool: 'delegate', result: { error: resultText } };
          } else {
            const result = await runAgentToEnd({ agent: worker, input: task, client });
            for (const event of result.events) yield event;
            resultText = result.output || result.error || '（工人没有产出）';
            yield { type: 'tool-result', agent: router.name, tool: 'delegate', result: { worker: workerName, output: resultText } };
          }
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify({ worker: workerName, output: resultText }),
          });
        }
      }
    }
    yield { type: 'agent-end', agent: router.name, output, toolRounds: round - 1 };
    yield { type: 'flow-end', flow: 'supervisor', output };
  } catch (e) {
    yield { type: 'agent-error', agent: router.name, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 收集编排事件流，返回最终输出 */
export async function runFlowToEnd(
  flow: AsyncGenerator<FlowEvent>,
): Promise<{ output: string; events: FlowEvent[] }> {
  const events: FlowEvent[] = [];
  let output = '';
  for await (const event of flow) {
    events.push(event);
    if (event.type === 'flow-end') output = event.output;
  }
  return { output: output ?? '', events };
}
