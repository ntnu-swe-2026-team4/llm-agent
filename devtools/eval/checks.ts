// 程式判斷：要用程式檢查的標準，寫在任務的 eval.ts
//   export default defineChecks("任務名稱", { "名稱": 判斷函式 })
//   evals.json 裡的檢查選「用程式檢查」時，用名稱引用這裡的函式
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { all as tasks } from "../../index.ts";
import type { DialogueTask, OneShotTask, Registered } from "../../runtime/define.ts";
import { LLMError } from "../../runtime/errors.ts";
import type { InputOf, OutputOf, ProgressOf } from "../../runtime/llm.ts";

type Tasks = typeof tasks;
type Name = keyof Tasks & string;

export type Verdict = boolean | { pass: boolean; reason: string };

/** 單次型的程式判斷：output 是 AI 交的結果（沒寫 output 格式的任務是一段文字）；run 可以用同一個版本再跑一次（做比較型測試） */
type OneShotCheck<T extends OneShotTask> = (
  output: OutputOf<T>,
  context: { input: InputOf<T>; run(input: InputOf<T>): Promise<OutputOf<T>> },
) => Verdict | Promise<Verdict>;

/** 對話型的程式判斷：transcript 是整段對話，progress 是對話結束時的進度 */
type DialogueCheck<T extends DialogueTask> = (result: { transcript: string; progress: ProgressOf<T> }) => Verdict | Promise<Verdict>;

type CheckOf<T> = T extends OneShotTask ? OneShotCheck<T> : T extends DialogueTask ? DialogueCheck<T> : never;

/** eval.ts 的寫法：export default defineChecks("任務名稱", { "名稱": 判斷函式 }) */
export function defineChecks<K extends Name>(_name: K, checks: Record<string, CheckOf<Tasks[K]>>) {
  return checks;
}

export const checksPath = (task: Registered) => join(task.dir, "eval.ts");

export async function loadChecks(task: Registered): Promise<Record<string, (...args: any[]) => Verdict | Promise<Verdict>>> {
  const f = checksPath(task);
  if (!existsSync(f)) return {};
  return ((await import(pathToFileURL(f).href)).default ?? {}) as never;
}

/** 網頁上按「建立 eval.ts」時寫進去的內容 */
export function createChecksFile(task: Registered) {
  const f = checksPath(task);
  if (existsSync(f)) throw new LLMError("llm_invalid_input", `${task.name}/eval.ts 已經存在`);
  const example = task.kind === "oneshot"
    ? `  // "名稱": (output, { input }) => true,   // output 是 AI 交回的結果；回傳 true / false，或 { pass, reason }`
    : `  // "名稱": ({ transcript, progress }) => true,   // transcript 是整段對話；回傳 true / false，或 { pass, reason }`;
  writeFileSync(f, `// ${task.name} 的程式判斷：在網頁「比較版本」的 ② 選「用程式檢查」，就能用這裡的名稱
import { defineChecks } from "../../devtools/eval/checks.ts";

export default defineChecks("${task.name}", {
${example}
});
`);
}
