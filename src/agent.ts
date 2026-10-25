import type { AgentDefinition, AgentEvent, ChatMessage, JsonObject, LlmClient } from './types.js';
import { validateArgs } from './schema.js';

export type RunAgentOptions = {
  agent: AgentDefinition;
  input: string;
  client: LlmClient;
};

export type AgentResult = {
  output: string;
  toolRounds: number;
  events: AgentEvent[];
  ok: boolean;
  error?: string;
};

/**
 * Agent 主循环（事件流形式）：
 *   LLM 生成 → 解析工具调用 → 校验参数 → 本地执行 → 结果回传 → 继续生成
 * 到达 maxSteps 后强制进行一次"无工具"的收尾生成，保证总有文本产出。
 * 工具报错不中断循环——错误信息作为工具结果回给模型，让它自行纠正或放弃。
 */
export async function* runAgent(options: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const { agent, client } = options;
  const maxSteps = agent.maxSteps ?? 5;
  const messages: ChatMessage[] = [
    { role: 'system', content: agent.instructions },
    { role: 'user', content: options.input },
  ];
  let toolRounds = 0;

  yield { type: 'agent-start', agent: agent.name, input: options.input };
  try {
    let output = '';
    while (true) {
      // 达到轮数上限后收走工具，逼模型给出最终文本
      const tools = toolRounds >= maxSteps ? undefined : agent.tools;
      yield { type: 'llm-request', agent: agent.name, step: toolRounds + 1 };
      const res = await client.chat(messages, tools);
      messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });

      if (res.toolCalls.length === 0) {
        output = res.content;
        break;
      }
      toolRounds++;
      for (const call of res.toolCalls) {
        yield { type: 'tool-call', agent: agent.name, tool: call.name, args: call.args };
        const result = await executeToolSafely(agent, call.name, call.args);
        yield { type: 'tool-result', agent: agent.name, tool: call.name, result };
        messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
      }
    }
    yield { type: 'agent-end', agent: agent.name, output, toolRounds };
  } catch (e) {
    yield { type: 'agent-error', agent: agent.name, error: e instanceof Error ? e.message : String(e) };
  }
}

async function executeToolSafely(
  agent: AgentDefinition,
  name: string,
  args: JsonObject,
): Promise<JsonObject> {
  const tool = agent.tools?.find((t) => t.name === name);
  if (!tool) return { error: `未知工具：${name}` };
  const validationError = validateArgs(tool.parameters, args);
  if (validationError) return { error: `参数校验失败：${validationError}` };
  try {
    return await tool.execute(args);
  } catch (e) {
    return { error: `工具执行出错：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 收集整个事件流并返回最终结果的便捷入口 */
export async function runAgentToEnd(options: RunAgentOptions): Promise<AgentResult> {
  const events: AgentEvent[] = [];
  let output = '';
  let toolRounds = 0;
  let error: string | undefined;
  for await (const event of runAgent(options)) {
    events.push(event);
    if (event.type === 'agent-end') {
      output = event.output;
      toolRounds = event.toolRounds;
    }
    if (event.type === 'agent-error') error = event.error;
  }
  return { output, toolRounds, events, ok: !error, error };
}
