// 對話型：不記狀態。每次呼叫帶入「對話紀錄 + 上一輪的狀態」，回一則 AI 回覆（串流）
//
//   送給模型的 messages：
//     system  main.prompt 的 system 段落（每輪依狀態重新渲染）
//     user    main.prompt 的 user 段落（題目這類背景資料），一定放在最前面
//     …       對話紀錄（使用者、AI 交替）
//   AI 要更新進度時會呼叫任務的工具（tools）：框架執行、用新狀態重新渲染 system、把結果回給模型，模型再接著回覆
//   回覆完回傳新的狀態和進度，呼叫端存起來，下次再傳回來
import type { Static } from "typebox";
import { connection } from "./config.ts";
import type { DialogueTask, Registered, ToolDef } from "./define.ts";
import { LLMError } from "./errors.ts";
import { chat, type ChatMessage, type ChatResult, type ToolCall } from "./model.ts";
import type { RunOptions } from "./oneshot.ts";
import { renderTask, sampling } from "./prepare.ts";
import { check, strict } from "./schema.ts";
import { streamed, type Streamed } from "./stream.ts";

/** 一則對話紀錄（跟後端資料庫存的一樣：誰說的、說了什麼） */
export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export interface Conversation<S> {
  /** 到目前為止的對話；最後一則是使用者剛說的話。AI 先開口的任務，開場時傳空的 */
  history?: HistoryMessage[];
  /** 上一輪回傳的 state；第一輪不用給 */
  state?: S;
}

/** 一輪回覆完的結果 */
export interface Turn<S, P> {
  /** AI 這一輪的完整回覆 */
  text: string;
  /** 新的狀態：存起來，下一輪傳回來 */
  state: S;
  /** task.ts 的 progress */
  progress: P;
  /** 這是第幾輪（AI 的第幾則回覆） */
  round: number;
}

/** 一則 AI 回覆：用 for await 一段段拿文字；result 是整則回覆完的結果（不串流的話直接 await 它） */
export type Reply<S, P> = Streamed<Turn<S, P>>;

/** 工具最多來回幾次（防止模型一直呼叫工具不回話） */
const MAX_TOOL_STEPS = 3;

function checkHistory(task: Registered<DialogueTask>, history: HistoryMessage[]) {
  const bad = history.findIndex(m => (m?.role !== "user" && m?.role !== "assistant") || typeof m.text !== "string");
  if (bad >= 0) throw new LLMError("llm_invalid_input", `${task.name}：對話紀錄第 ${bad + 1} 則的格式不對（要 { role: "user" | "assistant", text }）`);
  if (!history.length && task.opener !== "ai") {
    throw new LLMError("llm_invalid_input", `${task.name}：對話紀錄是空的。這個任務由使用者先說，最後一則要是使用者的話`);
  }
  if (history.length && history[history.length - 1]!.role !== "user") {
    throw new LLMError("llm_invalid_input", `${task.name}：對話紀錄的最後一則要是使用者剛說的話`);
  }
}

/** 執行模型要求的工具（可以是非同步，例如要連網查詢）；參數不對就把錯誤告訴模型，讓它修正 */
async function runTool<S>(tools: ToolDef<S, any>[], call: ToolCall, state: S): Promise<string> {
  const tool = tools.find(t => t.name === call.name);
  if (!tool) return `沒有叫「${call.name}」的工具`;
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return "參數不是合法的 JSON";
  }
  const errors = check(tool.parameters, args);
  if (errors.length) return `參數不對：${errors.join("；")}`;
  return tool.run(args as never, state);
}

async function* run<S, P>(
  task: Registered<DialogueTask<any, S, P>>,
  input: unknown,
  conversation: Conversation<S>,
  options: RunOptions,
): AsyncGenerator<string, Turn<S, P>> {
  const history = conversation.history ?? [];
  checkHistory(task as Registered<DialogueTask>, history);
  const round = history.filter(m => m.role === "assistant").length + 1;
  const state = structuredClone(conversation.state ?? task.state()) as S;
  const r = await renderTask(task, input, { variant: options.variant, state, round, history });

  // 離線模式：不呼叫模型，回固定的假回覆，狀態不變
  if (!options.chat && connection(options.connection).mock) {
    const text = `（mock 回覆：第 ${round} 輪）`;
    yield text;
    return { text, state, progress: task.progress(state, round), round };
  }

  const messages: ChatMessage[] = [{ role: "system", content: r.system }];
  if (r.user || !history.length) messages.push({ role: "user", content: r.user || "開始。" });
  for (const m of history) messages.push({ role: m.role, content: m.text });

  const tools = task.tools?.(def => def) ?? [];
  const specs = tools.map(t => ({ name: t.name, description: t.description, parameters: strict(t.parameters) }));
  const chatFn = options.chat ?? chat;
  let text = "";

  for (let step = 0; ; step++) {
    const stream = chatFn({ messages, tools: specs.length ? specs : undefined, ...sampling(r.config), model: options.model, connection: options.connection, signal: options.signal });
    let result: ChatResult;
    for (;;) {
      const next = await stream.next();
      if (next.done) { result = next.value; break; }
      text += next.value;
      yield next.value;
    }
    if (!result.toolCalls.length || step >= MAX_TOOL_STEPS) break;

    // 模型要用工具：記下它的請求、執行、把結果交回去，再請它接著回覆
    const calls = result.toolCalls.map((c, i) => ({ ...c, id: c.id || `call_${step}_${i}` }));
    messages.push({
      role: "assistant",
      content: result.text,
      tool_calls: calls.map(c => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })),
    });
    for (const c of calls) messages.push({ role: "tool", tool_call_id: c.id, content: await runTool(tools, c, state) });
    // 模型已經寫了回覆：工具照樣執行，不再請它接著寫（不然同一則回覆會出現兩次）
    if (result.text.trim()) break;
    // 工具改了狀態：用新狀態重新渲染 system，模型接著回覆時就照新狀態（promptInput 同一輪可能被呼叫多次）
    messages[0] = { role: "system", content: (await renderTask(task, input, { variant: options.variant, state, round, history })).system };
  }

  // 模型只呼叫工具、沒寫回覆（或回了空白）：不給工具，再請它回覆一次
  if (!text.trim()) {
    const stream = chatFn({ messages, tools: undefined, ...sampling(r.config), model: options.model, connection: options.connection, signal: options.signal });
    for (;;) {
      const next = await stream.next();
      if (next.done) break;
      text += next.value;
      yield next.value;
    }
  }

  return { text, state, progress: task.progress(state, round), round };
}

export function reply<S, P>(
  task: Registered<DialogueTask<any, S, P>>,
  input: Static<DialogueTask["input"]>,
  conversation: Conversation<S> = {},
  options: RunOptions = {},
): Reply<S, P> {
  return streamed(run(task, input, conversation, options));
}
