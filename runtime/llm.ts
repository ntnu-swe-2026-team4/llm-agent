// 把註冊的任務變成後端呼叫的 llm.任務名()
//   單次型 "position-draft"      → llm.positionDraft(input, options?)                          → await 拿輸出；輸出是文字的可以 for await 串流
//   對話型 "socratic-dialogue"   → llm.socraticDialogue(input, { history, state }, options?) → Reply（串流）
import type { Static } from "typebox";
import type { DialogueTask, OneShotTask, OutputValue, Registered, Task } from "./define.ts";
import { reply, type Conversation, type Reply } from "./dialogue.ts";
import { answer, type Answer, type RunOptions } from "./oneshot.ts";

type Camel<S extends string> = S extends `${infer H}-${infer T}` ? `${H}${Capitalize<Camel<T>>}` : S;

type Call<T> =
  T extends OneShotTask<infer I, infer O> ? (input: Static<I>, options?: RunOptions) => Answer<OutputValue<O>>
  : T extends DialogueTask<infer I, infer S, infer P> ? (input: Static<I>, conversation?: Conversation<S>, options?: RunOptions) => Reply<S, P>
  : never;

export type LLM<T extends Record<string, Task>> = { [K in keyof T & string as Camel<K>]: Call<T[K]> };

/** 某個任務的輸入型別（後端用 index.ts 的 Input<"名稱">） */
export type InputOf<T extends Task> = Static<T["input"]>;
/** 某個單次型任務的輸出型別：寫了 output 是那個格式，沒寫是 string */
export type OutputOf<T extends Task> = T extends OneShotTask<any, infer O> ? OutputValue<O> : never;
/** 某個對話型任務的狀態型別 */
export type StateOf<T extends Task> = T extends DialogueTask<any, infer S, any> ? S : never;
/** 某個對話型任務的進度型別 */
export type ProgressOf<T extends Task> = T extends DialogueTask<any, any, infer P> ? P : never;

export const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function createLLM<T extends Record<string, Registered>>(tasks: T): LLM<T> {
  const llm: Record<string, unknown> = {};
  for (const task of Object.values(tasks)) {
    llm[camel(task.name)] = task.kind === "oneshot"
      ? (input: unknown, options?: RunOptions) => answer(task as Registered<OneShotTask>, input as never, options)
      : (input: unknown, conversation?: Conversation<unknown>, options?: RunOptions) =>
          reply(task as Registered<DialogueTask>, input as never, conversation, options);
  }
  return llm as LLM<T>;
}
