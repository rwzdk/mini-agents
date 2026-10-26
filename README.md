# mini-agents

**零依赖的 TypeScript 多智能体编排库**：Agent 循环、工具调用、`pipeline` / `supervisor` 两种编排模式，全部核心逻辑约 500 行可读源码。注入任意 LLM 客户端（内置 OpenAI 兼容实现，或测试用的 Mock）。

> 这是我的作品集中的"基建层"作品：与其只做应用，不如把 Agent 的内部机制亲手写一遍——工具调用协议、编排循环、事件流、确定性测试，每一层都能讲清楚。

## 为什么写这个库

- **理解 > 使用**：LangChain/LlamaIndex 能快速出活，但面试官问"Agent 循环到底怎么运转、工具结果怎么回传、多智能体怎么路由"时，答案应该在写过的代码里，而不是文档里
- **零依赖**：核心只依赖 Node.js 内置能力（连 zod 都不用，工具参数用原生 JSON Schema 极简子集 + 自写校验），`npm ls --prod` 是空的
- **确定性可测**：LLM 通过 `LlmClient` 接口注入，测试里换成脚本化 Mock 就能 100% 复现执行路径——Agent 代码也能有传统意义上的单元测试
- **事件流优先**：`runAgent` 是 AsyncGenerator，每次 LLM 调用 / 工具调用 / 结果回传都是一个事件，调试、可视化、落库都只是消费这个流

## 快速开始

```bash
npm install        # 安装 dev 依赖（运行时零依赖）
npm test           # 13+ 确定性测试（Mock LLM）
npm run demo       # 零 Key 演示：pipeline + supervisor 全流程
```

### 定义工具（JSON Schema + 自带参数校验）

```ts
import { defineTool } from '@ordeal/mini-agents';

const search = defineTool({
  name: 'search',
  description: '搜索内部知识库',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: '关键词' }, limit: { type: 'number' } },
    required: ['query'],
  },
  execute: async ({ query, limit }) => findDocs(query, limit ?? 5),
});
```

### 单个 Agent：工具调用循环

```ts
import { runAgentToEnd, createOpenAIClient } from '@ordeal/mini-agents';

const client = createOpenAIClient({
  apiKey: process.env.MINI_AGENTS_API_KEY!,
  baseUrl: process.env.MINI_AGENTS_BASE_URL,       // DeepSeek / 通义等兼容接口
  model: process.env.MINI_AGENTS_MODEL ?? 'gpt-4o-mini',
});

const { output, toolRounds, events } = await runAgentToEnd({
  agent: { name: 'researcher', instructions: '检索后回答', tools: [search], maxSteps: 5 },
  input: 'mini-agents 的测试策略是什么？',
  client,
});
```

### pipeline：串行流水线（前一个的输出是后一个的输入）

```ts
import { pipeline, runFlowToEnd } from '@ordeal/mini-agents';

const { output, events } = await runFlowToEnd(
  pipeline({
    agents: [researcher /* 带工具 */, writer /* 纯生成 */],
    input: '总结 https://nodejs.org',
    client,
  }),
);
```

### supervisor：主管模式（router 委派 workers）

```ts
import { supervisor, runFlowToEnd } from '@ordeal/mini-agents';

const { output } = await runFlowToEnd(
  supervisor({
    router: { name: 'router', instructions: '你是任务主管，负责分派与汇总。' },
    workers: [translator, calculator, summarizer],
    input: '把这段英文翻译成中文并计算字数',
    client,
    maxRounds: 6,
  }),
);
```

`delegate(worker, task)` / `finish(answer)` 是 supervisor 注入给 router 的元工具；worker 的完整事件流会透传到外层。

## 架构

```
runAgent（AsyncGenerator<AgentEvent>）
 └─ 循环：client.chat(messages, tools?)          ← LlmClient 接口（可注入任意实现）
        ├─ 无工具调用 → 产出文本，结束
        └─ 有工具调用 → validateArgs（JSON Schema 校验）
                          ├─ 校验失败 → 错误作为工具结果回传，模型自行纠正
                          └─ execute(args) → role:"tool" 消息追加 → 下一轮
        （达到 maxSteps 后收走工具，强制一次无工具收尾生成）

pipeline(agent₁…agentₙ)     前一个 agent-end 的 output 作为下一个的输入
supervisor(router, workers) router 用注入的 delegate/finish 元工具指挥 workers
```

```
src/
├── types.ts         全部类型（LlmClient 是唯一的外部边界）
├── schema.ts        defineTool + 极简 JSON Schema 参数校验
├── llm.ts           OpenAI 兼容客户端（原生 fetch，从零实现）
├── agent.ts         Agent 主循环（事件流 + 安全执行 + maxSteps 收尾）
├── orchestrator.ts  pipeline / supervisor 编排
└── index.ts         导出
```

## 设计决策（面试可展开的点）

| 决策 | 理由 |
| --- | --- |
| LLM 抽象成 `LlmClient` 接口 | 换模型/换厂商零改动；测试注入 Mock 获得 100% 确定性 |
| 工具错误不抛异常，作为结果回传 | 让模型看到错误自行纠正，比中断整个循环更符合 Agent 语义 |
| `maxSteps` 到达后收走工具再问一次 | 保证任何情况下都有文本产出，永不空转 |
| 参数校验用 JSON Schema 极简子集 | 零依赖的同时覆盖真实工具的全部需求；校验失败同样回传模型 |
| 事件流用 AsyncGenerator 而非回调 | 消费端自由选择：打日志、渲染 UI、落库、做 trace |
| supervisor 用元工具而非自由文本路由 | 结构化委派可校验、可回放，router 无法"幻觉"出不存在的工人 |

## 测试

```bash
npm test
```

覆盖：工具循环（成功 / 未知工具 / 校验失败 / 执行抛错 / maxSteps 强制收尾 / LLM 异常）、pipeline 链式传参、supervisor 委派 / 未知工人回传 / 直接回答 / 轮数上限、参数校验边界。全部使用脚本化 Mock LLM，无网络依赖，纳入 GitHub Actions CI。

## Roadmap

- [ ] 发布到 npm
- [ ] agent-workbench 改用本库驱动（应用与框架互相印证）
- [ ] parallel / DAG 编排模式与循环终止条件
- [ ] 事件流录制与确定性回放（调试工具）
- [ ] 可观测：事件流一键转 OpenTelemetry span

## License

MIT
