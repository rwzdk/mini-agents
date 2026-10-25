import type { ChatMessage, LlmClient, LlmResponse, ToolDefinition } from './types.js';

type OpenAIClientOptions = {
  /** OpenAI 兼容接口地址，默认 https://api.openai.com/v1 */
  baseUrl?: string;
  apiKey: string;
  model: string;
  /** 请求超时（毫秒），默认 60_000 */
  timeoutMs?: number;
};

type OpenAiChatResponse = {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: {
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }[];
    };
    finish_reason?: string;
  }[];
};

function toWireMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * 从零实现的 OpenAI 兼容 Chat 客户端（原生 fetch，无任何 SDK 依赖）。
 * 支持 DeepSeek / 通义 / Moonshot 等任何兼容服务。
 */
export function createOpenAIClient(options: OpenAIClientOptions): LlmClient {
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  return {
    async chat(messages, tools) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            messages: toWireMessages(messages),
            ...(tools && tools.length > 0
              ? {
                  tools: tools.map((t) => ({
                    type: 'function',
                    function: {
                      name: t.name,
                      description: t.description,
                      parameters: t.parameters,
                    },
                  })),
                }
              : {}),
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`LLM 请求失败 ${res.status}：${body.slice(0, 300)}`);
        }
        const data = (await res.json()) as OpenAiChatResponse;
        const message = data.choices?.[0]?.message;
        const toolCalls = (message?.tool_calls ?? []).map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments || '{}') as Record<string, never>,
        }));
        return {
          content: message?.content ?? '',
          toolCalls,
          finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        } satisfies LlmResponse;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
