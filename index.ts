// 後端只 import 這個檔
//   import { llm, LLMError } from "../../../llm-framework/index.ts";
//   const draft = await llm.positionDraft({ ... });                         // 單次型
//   const reply = llm.socraticDialogue(input, { history, state });          // 對話型（串流）
import { defineTasks } from "./runtime/define.ts";
import { createLLM, type InputOf, type OutputOf, type ProgressOf, type StateOf } from "./runtime/llm.ts";

// ↑ 任務的 import（bun llm new 會自動加在這行上面）

// 範例
import socraticDialogue from "./examples/socratic-dialogue/task.ts";
import counterexample from "./examples/counterexample/task.ts";
import debateJudge from "./examples/debate-judge/task.ts";

/** 正式任務；名稱 = tasks/ 底下的資料夾名稱。後端的 llm.任務名() 只有這些 */
export const tasks = defineTasks("tasks", {
  // ↑ 任務清單（bun llm new 會自動加在這行上面）
});

/** 範例：示範任務怎麼寫，不是產品的一部分。開發工具看得到，後端的 llm 裡沒有 */
export const examples = defineTasks("examples", {
  "socratic-dialogue": socraticDialogue,
  "counterexample": counterexample,
  "debate-judge": debateJudge,
});

/** 開發工具（bun llm、網頁、測試、評估）看得到的全部：正式任務加範例 */
export const all = { ...examples, ...tasks };

/** 後端呼叫的 AI 功能：名稱轉成駝峰，例："position-draft" → llm.positionDraft */
export const llm = createLLM(tasks);

export { LLMError, type LLMErrorCode } from "./runtime/errors.ts";
export type { Conversation, HistoryMessage, Reply, Turn } from "./runtime/dialogue.ts";
export type { Answer, RunOptions } from "./runtime/oneshot.ts";
export type { ConnectionSettings } from "./runtime/config.ts";

type Tasks = typeof all;
/** 輸入型別，例：Input<"position-draft"> */
export type Input<K extends keyof Tasks> = InputOf<Tasks[K]>;
/** 單次型的輸出型別（沒寫 output 的任務是 string） */
export type Output<K extends keyof Tasks> = OutputOf<Tasks[K]>;
/** 對話型的狀態型別（要存進資料庫的那份） */
export type State<K extends keyof Tasks> = StateOf<Tasks[K]>;
/** 對話型的進度型別 */
export type Progress<K extends keyof Tasks> = ProgressOf<Tasks[K]>;
