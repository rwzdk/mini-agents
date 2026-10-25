// 真实 LLM 演示：researcher（抓取网页工具）→ writer（总结成中文摘要）。
// 运行前配置环境变量（参考 .env.example）：
//   MINI_AGENTS_API_KEY / MINI_AGENTS_BASE_URL / MINI_AGENTS_MODEL
// 然后：npm run build && node examples/research.js https://nodejs.org

import { createOpenAIClient, defineTool, pipeline, runFlowToEnd } from '../dist/index.js';

const apiKey = process.env.MINI_AGENTS_API_KEY;
if (!apiKey) {
  console.error('缺少 MINI_AGENTS_API_KEY，参考 .env.example 配置后重试。');
  process.exit(1);
}
const url = process.argv[2] ?? 'https://nodejs.org';

const client = createOpenAIClient({
  apiKey,
  baseUrl: process.env.MINI_AGENTS_BASE_URL,
  model: process.env.MINI_AGENTS_MODEL ?? 'gpt-4o-mini',
});

const fetchPage = defineTool({
  name: 'fetch_page',
  description: '抓取公开网页，返回标题与正文摘要（前 3000 字符）',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: '要抓取的网页地址' } },
    required: ['url'],
  },
  execute: async ({ url: target }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(String(target), { signal: controller.signal });
      const html = await res.text();
      const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? '';
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return { title, excerpt: text.slice(0, 3000) };
    } finally {
      clearTimeout(timer);
    }
  },
});

const researcher = {
  name: 'researcher',
  instructions: '你是信息检索员：用 fetch_page 工具抓取用户给的网址，提炼页面核心事实（3-5 条要点），不要编造。',
  tools: [fetchPage],
};

const writer = {
  name: 'writer',
  instructions: '你是技术作者：把研究员给出的要点整理成 100 字以内的中文摘要，语气客观。',
};

const { output, events } = await runFlowToEnd(
  pipeline({ agents: [researcher, writer], input: `请总结这个页面：${url}`, client }),
);

for (const ev of events) {
  if (ev.type === 'tool-call') console.log(`🔧 [${ev.agent}] 调用 ${ev.tool} ${JSON.stringify(ev.args)}`);
  if (ev.type === 'agent-end') console.log(`✅ [${ev.agent}] 完成（${ev.toolRounds} 轮工具调用）`);
}
console.log('\n📝 最终摘要：\n' + output);
