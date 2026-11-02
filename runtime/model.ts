// 呼叫模型：OpenAI 相容的 POST {baseUrl}/chat/completions（ADR-0001），一律串流
//   - 一段段吐出文字；結束時回傳整段文字和模型要呼叫的工具
//   - 還沒吐出任何文字前碰到限流、5xx、網路斷：等 3、6、12、24 秒各重試一次
//   - 錯誤分類跟後端原本一樣：額度用完不重試（重試也不會成功），限流回 429
//   - delta.reasoning_content（思考過程）不是回覆內容，直接略過
import { connection, type Connection, type ConnectionSettings } from "./config.ts";
import { LLMError } from "./errors.ts";

export interface ToolCall {
  id: string;
  name: string;
  /** 模型填的參數（JSON 字串，還沒檢查） */
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** 要模型只回一個 JSON 物件（response_format: json_object） */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** 換模型；不給就用設定的預設模型 */
  model?: string;
  /** 連線設定（key、網址等）；不給就照環境變數和 models.json */
  connection?: ConnectionSettings;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
}

/** 呼叫模型的函式：一段段吐出文字，最後回傳整段文字和工具呼叫。測試可以換成假的 */
export type ChatFn = (request: ChatRequest) => AsyncGenerator<string, ChatResult>;

// ─────────────────────────── 重試的通知 ───────────────────────────

/** 想知道什麼時候在等待重試（例如評估的即時輸出），就設定這個；預設不印任何東西 */
let retryLog: ((line: string) => void) | null = null;
export const onRetry = (log: (line: string) => void) => void (retryLog = log);

// ─────────────────────────── 錯誤分類 ───────────────────────────

/** GLM 的錯誤碼：1111–1114 是額度用完（重試沒用），1302–1305 是併發與限流 */
const QUOTA_CODES = new Set(["1111", "1112", "1113", "1114"]);
const RATE_CODES = new Set(["1302", "1303", "1305"]);

function errorCodeOf(body: string): string {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } }).error?.code;
    return code === undefined || code === null ? "" : String(code);
  } catch {
    return "";
  }
}

/** HTTP 錯誤 → LLMError，並標出值不值得重試 */
function httpError(status: number, body: string): { error: LLMError; retry: boolean } {
  const code = errorCodeOf(body);
  const detail = `HTTP ${status}${body ? `：${body.slice(0, 300)}` : ""}`;
  if (QUOTA_CODES.has(code)) return { error: new LLMError("llm_unavailable", `呼叫模型失敗（額度用完）：${detail}`), retry: false };
  if (RATE_CODES.has(code) || status === 429) return { error: new LLMError("llm_rate_limited", `呼叫模型失敗（限流）：${detail}`), retry: true };
  return { error: new LLMError("llm_unavailable", `呼叫模型失敗：${detail}`), retry: status >= 500 };
}

// ─────────────────────────── 呼叫 ───────────────────────────

const RETRY_DELAYS_MS = [3000, 6000, 12000, 24000];
/** 這麼久沒收到任何資料就放棄 */
const IDLE_TIMEOUT_MS = 60_000;

function requestBody(c: Connection, request: ChatRequest) {
  return {
    ...c.params,
    model: c.model,
    stream: true,
    messages: request.messages,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.json ? { response_format: { type: "json_object" } } : {}),
    ...(request.tools?.length
      ? { tools: request.tools.map(t => ({ type: "function", function: t })) }
      : {}),
  };
}

/** 送一次請求，讀完整個串流。retryable 表示還沒吐出文字前失敗、可以重試 */
async function* once(c: Connection, request: ChatRequest): AsyncGenerator<string, ChatResult> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ((timedOut = true), controller.abort()), IDLE_TIMEOUT_MS);
  };
  const onAbort = () => controller.abort();
  request.signal?.addEventListener("abort", onAbort);
  resetTimer();

  const failed = (midStream: boolean) =>
    timedOut
      ? new LLMError("llm_timeout", `呼叫模型失敗：${IDLE_TIMEOUT_MS / 1000} 秒沒有回應`, midStream)
      : new LLMError("llm_unavailable", "呼叫模型失敗：連線中斷", midStream);

  try {
    let res: Response;
    try {
      res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(requestBody(c, request)),
      });
    } catch {
      throw Object.assign(failed(false), { retryable: !timedOut && !request.signal?.aborted });
    }
    if (!res.ok || !res.body) {
      const { error, retry } = httpError(res.status, await res.text().catch(() => ""));
      throw Object.assign(error, { retryable: retry });
    }

    let text = "";
    const calls: { id: string; name: string; arguments: string }[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          throw Object.assign(failed(text.length > 0), { retryable: !timedOut && !request.signal?.aborted });
        }
        if (chunk.done) break;
        resetTimer();
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return { text, toolCalls: calls };
          let payload: any;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          if (payload.error) {
            const { error } = httpError(RATE_CODES.has(String(payload.error.code ?? "")) ? 429 : 503, JSON.stringify(payload));
            throw new LLMError(error.code, error.message, text.length > 0);
          }
          const choice = payload.choices?.[0];
          if (choice?.finish_reason === "error") throw new LLMError("llm_unavailable", "呼叫模型失敗：供應商回報錯誤", text.length > 0);
          const delta = choice?.delta ?? {};
          if (typeof delta.content === "string" && delta.content) {
            text += delta.content;
            yield delta.content;
          }
          // 工具呼叫是分段送來的：同一個 index 的片段接起來
          for (const part of delta.tool_calls ?? []) {
            const slot = (calls[part.index ?? 0] ??= { id: "", name: "", arguments: "" });
            if (part.id) slot.id = part.id;
            if (part.function?.name) slot.name += part.function.name;
            if (part.function?.arguments) slot.arguments += part.function.arguments;
          }
        }
      }
      return { text, toolCalls: calls.filter(Boolean) };
    } finally {
      reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}

/** 正式的呼叫：沒設 key 直接丟 llm_not_configured；還沒吐出文字前失敗就重試 */
export async function* chat(request: ChatRequest): AsyncGenerator<string, ChatResult> {
  const c = connection({ ...request.connection, ...(request.model ? { model: request.model } : {}) });
  if (!c.apiKey) throw new LLMError("llm_not_configured", `沒有設定 API key：請在 .env 設定 ${c.provider.toUpperCase()}_API_KEY`);
  if (!c.baseUrl) throw new LLMError("llm_not_configured", `沒有設定模型的網址：providers/models.json 的 ${c.provider}.baseUrl`);

  for (let attempt = 0; ; attempt++) {
    let started = false;
    try {
      const stream = once(c, request);
      for (;;) {
        const next = await stream.next();
        if (next.done) return next.value;
        started = true;
        yield next.value;
      }
    } catch (e) {
      const retryable = (e as { retryable?: boolean }).retryable === true;
      if (started || !retryable || attempt >= RETRY_DELAYS_MS.length) throw e;
      const wait = RETRY_DELAYS_MS[attempt]!;
      retryLog?.(`${(e as Error).message.slice(0, 120)}，${wait / 1000} 秒後重試（第 ${attempt + 1}/${RETRY_DELAYS_MS.length} 次）`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

/** 不需要串流時：問一段話，拿回整段文字（評審 AI、產生測試資料用） */
export async function complete(request: ChatRequest, chatFn: ChatFn = chat): Promise<string> {
  const stream = chatFn(request);
  for (;;) {
    const next = await stream.next();
    if (next.done) return next.value.text;
  }
}
