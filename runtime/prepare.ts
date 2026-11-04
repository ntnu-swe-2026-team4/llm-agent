// 呼叫模型前的準備（單次型、對話型共用）：檢查輸入、渲染 prompt
import type { Registered, Task } from "./define.ts";
import type { HistoryMessage } from "./dialogue.ts";
import { LLMError } from "./errors.ts";
import { render, type Rendered } from "./prompt.ts";
import { check, strict } from "./schema.ts";

export function checkInput(task: Registered, input: unknown) {
  const errors = check(task.input, input);
  if (errors.length) throw new LLMError("llm_invalid_input", `${task.name} 的輸入不合格：\n- ${errors.join("\n- ")}`);
}

/**
 * 單次型寫了 output：框架在 system 最後補上「只交回這個格式的 JSON」。
 * 所以 main.prompt 不用自己寫輸出格式，改了 task.ts 的 output，送給模型的說明就跟著變
 */
export function outputInstruction(task: Registered): string {
  if (task.kind !== "oneshot" || !task.output) return "";
  return [
    "## 交回的格式",
    "只輸出一個 JSON 物件，不要有其他文字。格式（JSON Schema）：",
    "```json",
    JSON.stringify(strict(task.output), null, 2),
    "```",
  ].join("\n");
}

/** 渲染任務的 prompt（不呼叫模型）。對話型可指定狀態、第幾輪和對話紀錄，預設是第一輪的初始狀態 */
export async function renderTask<T extends Task>(
  task: Registered<T>,
  input: unknown,
  options: { variant?: string; state?: unknown; round?: number; history?: readonly HistoryMessage[] } = {},
): Promise<Rendered> {
  checkInput(task, input);
  if (task.kind === "oneshot") {
    const r = await render(task.dir, input as Record<string, unknown>, options.variant);
    return { ...r, system: [r.system, outputInstruction(task)].filter(Boolean).join("\n\n") };
  }
  const state = options.state ?? task.state();
  return render(task.dir, task.promptInput(input, state, options.round ?? 1, options.history ?? []), options.variant);
}

/** .prompt 檔頭的 config → 呼叫模型的參數 */
export const sampling = (config: Rendered["config"]) => ({
  temperature: typeof config.temperature === "number" ? config.temperature : undefined,
  maxTokens: typeof config.maxOutputTokens === "number" ? config.maxOutputTokens : undefined,
});
