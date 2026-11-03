// 任務的宣告：task.ts 用 defineOneShot / defineDialogue 寫
//   輸入、輸出格式只在這裡寫一次（TypeBox），TypeScript 型別、輸入檢查、要模型交回的格式都從這裡來
import type { Static, TObject } from "typebox";
import { join } from "node:path";
import { ROOT } from "./prompt.ts";
import type { HistoryMessage } from "./dialogue.ts";

// ─────────────────────────── 單次型 ───────────────────────────

/** 單次型的輸出：有 output → 那個格式的物件；沒有 → 一段文字 */
export type OutputValue<O> = [O] extends [TObject] ? Static<O> : string;

export interface OneShotDef<I extends TObject, O extends TObject | undefined> {
  /** 輸入格式：呼叫端傳進來的資料先照這個檢查，再交給 main.prompt */
  input: I;
  /**
   * 輸出格式（選填）。
   * 寫了：模型要交回這個格式的 JSON，格式不對框架會退回重問。
   * 沒寫：模型回一段文字，邊寫邊送（串流）。
   */
  output?: O;
  /** 範例輸入：bun llm render / try、網頁預覽和測試都用它 */
  example: Static<I>;
  /** 範例輸出：有 output 時必填，測試會檢查它符合 output。LLM_PROVIDER=mock 時直接回傳它 */
  exampleOutput?: OutputValue<O>;
}

export type OneShotTask<I extends TObject = TObject, O extends TObject | undefined = any> = OneShotDef<I, O> & { kind: "oneshot" };

/** 某個單次型任務的輸出型別 */
export type OneShotOutput<T> = T extends OneShotTask<any, infer O> ? OutputValue<O> : never;

export const defineOneShot = <I extends TObject, O extends TObject | undefined = undefined>(def: OneShotDef<I, O>): OneShotTask<I, O> =>
  ({ ...def, kind: "oneshot" });

// ─────────────────────────── 對話型 ───────────────────────────

export interface ToolDef<S, P extends TObject = TObject> {
  name: string;
  /** 給模型看的說明：什麼時候呼叫、參數怎麼填 */
  description: string;
  parameters: P;
  /** 模型呼叫時執行：更新狀態，回傳一句話給模型；可以是 async（例如要連網查詢） */
  run(args: Static<P>, state: S): string | Promise<string>;
}

/** tools 裡用的 tool()：讓 run 的 args 型別跟 parameters 對上 */
export type ToolFactory<S> = <P extends TObject>(def: ToolDef<S, P>) => ToolDef<S, P>;

export interface DialogueDef<I extends TObject, S, P> {
  /** 開對話時的輸入格式（題目這類，整段對話都一樣） */
  input: I;
  /** 範例輸入：bun llm render / try、網頁預覽和測試都用它 */
  example: Static<I>;
  /**
   * 誰先說話。"user"（預設）：使用者先說，AI 回。
   * "ai"：AI 先開口——對話紀錄是空的時候呼叫，AI 的回覆就是開場白（算第 1 輪）
   */
  opener?: "user" | "ai";
  /** 對話開始時的狀態（純資料：呼叫端會把它存進資料庫，下次再傳回來） */
  state(): S;
  /**
   * 每一輪 AI 回覆前呼叫，回傳這一輪 main.prompt 拿到的資料；round 從 1 開始。
   * 工具改了狀態後會用同一個 round 再呼叫一次，所以同一輪呼叫幾次結果都要一樣（不要在這裡累加計數）。
   * history 是到目前為止的對話紀錄（最後一則是使用者剛說的話；開場時是空的）
   */
  promptInput(input: Static<I>, state: S, round: number, history: readonly HistoryMessage[]): Record<string, unknown>;
  /** AI 可以呼叫的工具，用來回報對話進度、更新狀態 */
  tools?(tool: ToolFactory<S>): ToolDef<S, any>[];
  /** 每輪回覆完交給呼叫端的進度 */
  progress(state: S, round: number): P;
}

export type DialogueTask<I extends TObject = TObject, S = any, P = unknown> = DialogueDef<I, S, P> & { kind: "dialogue" };

export const defineDialogue = <I extends TObject, S, P>(def: DialogueDef<I, S, P>): DialogueTask<I, S, P> =>
  ({ ...def, kind: "dialogue" });

// ─────────────────────────── 註冊 ───────────────────────────

export type Task = OneShotTask<any, any> | DialogueTask<any, any, any>;

/** 註冊後的任務：多了名稱和資料夾位置 */
export type Registered<T extends Task = Task> = T & { name: string; dir: string };

/** index.ts 用：folder 是放任務的資料夾（tasks 或 examples），名稱就是底下的資料夾名稱 */
export function defineTasks<T extends Record<string, Task>>(folder: string, tasks: T): { [K in keyof T]: T[K] & { name: K; dir: string } } {
  const out: Record<string, Registered> = {};
  for (const [name, task] of Object.entries(tasks)) out[name] = { ...task, name, dir: join(ROOT, folder, name) };
  return out as never;
}
