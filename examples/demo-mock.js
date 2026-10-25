// 零配置演示：用脚本化 Mock 客户端跑通 pipeline 与 supervisor，无需任何 API Key。
// 运行：npm run example（会先构建再执行本文件）

import { pipeline, supervisor, runFlowToEnd } from '../dist/index.js';

/** 脚本化 LLM 客户端：按顺序吐出预设响应，行为完全确定 */
function scripted(responses) {
  let i = 0;
  return {
    async chat(_messages, tools) {
      if (i >= responses.length) throw new Error('脚本响应已耗尽');
      const next = responses[i++];
      return typeof next === 'function' ? next(_messages, tools) : next;
    },
  };
}

function logEvent(ev) {
  const head = `[${ev.type}]`.padEnd(14);
  if (ev.type === 'agent-start') console.log(`${head} ${ev.agent} 收到任务：${ev.input.slice(0, 40)}`);
  else if (ev.type === 'tool-call') console.log(`${head} ${ev.agent} 调用 ${ev.tool}(${JSON.stringify(ev.args)})`);
  else if (ev.type === 'tool-result') console.log(`${head} ${ev.agent} ← ${JSON.stringify(ev.result).slice(0, 80)}`);
  else if (ev.type === 'agent-end') console.log(`${head} ${ev.agent} 完成（${ev.toolRounds} 轮工具）：${ev.output.slice(0, 60)}`);
  else if (ev.type === 'flow-end') console.log(`${head} 最终输出：${ev.output.slice(0, 80)}\n`);
}

console.log('══════════ 1. pipeline：researcher（带工具）→ writer ══════════\n');
const pipeClient = scripted([
  // researcher 第一轮：调用计算工具
  { content: '', toolCalls: [{ id: 'c1', name: 'calc', args: { a: 12, b: 8 } }], finishReason: 'tool_calls' },
  // researcher 第二轮：基于工具结果作答
  { content: '12 × 8 = 96', toolCalls: [], finishReason: 'stop' },
  // writer：改写成一句话结论
  { content: '结论：一共 96 个座位。', toolCalls: [], finishReason: 'stop' },
]);

const researcher = {
  name: 'researcher',
  instructions: '你是严谨的研究员，需要计算时必须调用 calc 工具。',
  tools: [
    {
      name: 'calc',
      description: '计算乘法算式 a*b',
      parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
      execute: async ({ a, b }) => ({ value: Number(a) * Number(b) }),
    },
  ],
};
const writer = {
  name: 'writer',
  instructions: '你是技术作者，把研究员的结论改写成一句面向用户的中文结论。',
};

const pipe = await runFlowToEnd(
  pipeline({
    agents: [researcher, writer],
    input: '教室有 12 排座位，每排 8 个，一共多少个？',
    client: pipeClient,
  }),
);
pipe.events.forEach(logEvent);

console.log('══════════ 2. supervisor：router 委派 worker ══════════\n');
const supClient = scripted([
  // router 第一轮：委派给 translator
  { content: '', toolCalls: [{ id: 'd1', name: 'delegate', args: { worker: 'translator', task: '把 "hello world" 翻译成中文' } }], finishReason: 'tool_calls' },
  // translator：直接作答
  { content: '你好，世界', toolCalls: [], finishReason: 'stop' },
  // router 第二轮：结束
  { content: '', toolCalls: [{ id: 'f1', name: 'finish', args: { answer: '翻译结果：你好，世界' } }], finishReason: 'tool_calls' },
]);

const sup = await runFlowToEnd(
  supervisor({
    router: { name: 'router', instructions: '你是任务主管，负责分派与汇总。' },
    workers: [{ name: 'translator', instructions: '你是中英翻译，直接给出译文。' }],
    input: '把 "hello world" 翻译成中文',
    client: supClient,
  }),
);
sup.events.forEach(logEvent);
