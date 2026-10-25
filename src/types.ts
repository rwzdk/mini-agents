export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** 工具参数采用原生 JSON Schema 的极简子集：对象 + 五种标量/容器类型 */
export type JsonSchema = {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
};

export type JsonSchemaProperty = {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (args: JsonObject) => Promise<JsonObject>;
};

export type ToolCall = {
  id: string;
  name: string;
  args: JsonObject;
};

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export type LlmResponse = {
  content: string;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls';
};

/**
 * LLM 客户端接口：整个库只依赖这一个抽象。
 * 内置 OpenAI 兼容实现（createOpenAIClient），测试时注入脚本化 Mock 即可获得完全确定的行为。
 */
export interface LlmClient {
  chat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<LlmResponse>;
}

export type AgentDefinition = {
  name: string;
  instructions: string;
  tools?: ToolDefinition[];
  /** 工具调用轮数上限；到达后强制进行一次无工具的收尾生成，默认 5 */
  maxSteps?: number;
};

export type AgentEvent =
  | { type: 'agent-start'; agent: string; input: string }
  | { type: 'llm-request'; agent: string; step: number }
  | { type: 'tool-call'; agent: string; tool: string; args: JsonObject }
  | { type: 'tool-result'; agent: string; tool: string; result: JsonObject }
  | { type: 'agent-end'; agent: string; output: string; toolRounds: number }
  | { type: 'agent-error'; agent: string; error: string };

export type FlowEvent = AgentEvent | { type: 'flow-end'; flow: string; output: string };
