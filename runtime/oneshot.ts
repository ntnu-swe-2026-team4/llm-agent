// 單次型：給一份輸入，拿回一份輸出。輸出長什麼樣由 task.ts 決定：
//   沒寫 output：模型回一段文字，邊寫邊送（串流）
//   寫了 output：system 最後附上輸出格式 → 要模型只回 JSON → 照 output 檢查
//                格式不對：把錯在哪告訴模型，請它重交，最多重問 2 次
import type { Static } from "typebox";
import { connection, type ConnectionSettings } from "./config.ts";
import type { OneShotOutput, OneShotTask, Registered } from "./define.ts";
import { LLMError } from "./errors.ts";
import { chat, complete, type ChatFn, type ChatMessage, type ChatRequest } from "./model.ts";
import { renderTask, sampling } from "./prepare.ts";
import { check } from "./schema.ts";
import { streamed, type Streamed } from "./stream.ts";

export interface RunOptions {
  /** prompt 版本：main.<版本>.prompt；不給就用 main.prompt */
  variant?: string;
  /** 換模型；不給就用設定的預設模型（見 runtime/config.ts） */
  model?: string;
  /** 連線設定：key、網址、模型、mock。後端可以傳自己 config 裡的值；不給就照環境變數和 models.json */
  connection?: ConnectionSettings;
  /** 中途取消（例如使用者離開頁面） */
  signal?: AbortSignal;
  /** 換掉呼叫模型的方式（測試用） */
  chat?: ChatFn;
}

export interface OneShotStats {
  /** 格式不對、重問了幾次（輸出是文字的任務一定是 0） */
  retries: number;
}

export interface OneShotResult<O> {
  output: O;
  stats: OneShotStats;
}

/**
 * 單次型的回覆：
 *   await 它        → 輸出（文字或 JSON 物件）
 *   for await 它    → 一段段的文字（只有輸出是文字的任務會有；JSON 要檢查完才給，所以不會一段段吐）
 *   .result         → 輸出加上統計（重問了幾次）
 */
export interface Answer<O> extends Streamed<OneShotResult<O>>, PromiseLike<O> {}

const MAX_RETRIES = 2;

/** 模型有時會把 JSON 包在 ```json … ``` 裡或前後加說明：取出第一個 { 到最後一個 } */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
  } catch {
    return { ok: false };
  }
}

async function* run<T extends OneShotTask>(
  task: Registered<T>,
  input: Static<T["input"]>,
  options: RunOptions,
): AsyncGenerator<string, OneShotResult<unknown>> {
  const r = await renderTask(task, input, options);

  // 離線模式：不呼叫模型，回範例輸出
  if (!options.chat && connection(options.connection).mock) {
    if (task.output) return { output: structuredClone(task.exampleOutput), stats: { retries: 0 } };
    const text = typeof task.exampleOutput === "string" ? task.exampleOutput : "（mock 回覆）";
    yield text;
    return { output: text, stats: { retries: 0 } };
  }

  const messages: ChatMessage[] = [
    { role: "system", content: r.system },
    { role: "user", content: r.user || "開始。" },
  ];
  const request: Omit<ChatRequest, "messages"> = { ...sampling(r.config), model: options.model, connection: options.connection, signal: options.signal };
  const chatFn = options.chat ?? chat;

  // 輸出是文字：照模型吐的一段段送出去
  if (!task.output) {
    const stream = chatFn({ messages, ...request });
    let text = "";
    for (;;) {
      const next = await stream.next();
      if (next.done) break;
      text += next.value;
      yield next.value;
    }
    if (!text.trim()) throw new LLMError("llm_no_result", `${task.name}：模型沒有回任何文字`);
    return { output: text, stats: { retries: 0 } };
  }

  // 輸出是 JSON：檢查格式，不對就重問
  for (let retries = 0; ; retries++) {
    const text = await complete({ messages, json: true, ...request }, chatFn);
    const parsed = parseJson(text);
    const errors = parsed.ok ? check(task.output, parsed.value) : ["回覆不是合法的 JSON"];
    if (!errors.length) return { output: (parsed as { value: unknown }).value, stats: { retries } };
    if (retries >= MAX_RETRIES) {
      throw new LLMError("llm_no_result", `${task.name}：重問 ${retries} 次，模型還是沒交出合格的結果：\n- ${errors.join("\n- ")}`);
    }
    messages.push(
      { role: "assistant", content: text },
      { role: "user", content: `格式不對：\n- ${errors.join("\n- ")}\n請只輸出一個符合格式的 JSON 物件。` },
    );
  }
}

/** 跑一次單次型任務 */
export function answer<T extends OneShotTask>(
  task: Registered<T>,
  input: Static<T["input"]>,
  options: RunOptions = {},
): Answer<OneShotOutput<T>> {
  const s = streamed(run(task, input, options)) as Streamed<OneShotResult<OneShotOutput<T>>>;
  return {
    [Symbol.asyncIterator]: () => s[Symbol.asyncIterator](),
    get result() {
      return s.result;
    },
    then: (onFulfilled, onRejected) => s.result.then(r => r.output).then(onFulfilled, onRejected),
  };
}

/** 只要最後的結果（開發工具用） */
export const runOneShot = <T extends OneShotTask>(task: Registered<T>, input: Static<T["input"]>, options: RunOptions = {}) =>
  answer(task, input, options).result;
