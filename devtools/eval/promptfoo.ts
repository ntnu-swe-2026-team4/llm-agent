// 把任務的 evals.json 轉成 promptfoo 的設定
//   勾選的每個版本 × 每筆測試資料各跑一次（task-provider.ts），評審 AI（judge-provider.ts）依標準打分
import type { Assertion, AssertionValueFunctionContext, GradingResult, UnifiedConfig } from "promptfoo";
import { fileURLToPath } from "node:url";
import { all as tasks } from "../../index.ts";
import type { Registered } from "../../runtime/define.ts";
import { LLMError } from "../../runtime/errors.ts";
import { runOneShot } from "../../runtime/oneshot.ts";
import { variants } from "../../runtime/prompt.ts";
import { loadChecks, type Verdict } from "./checks.ts";
import { readEvals, type Criterion } from "./evals-file.ts";
import { evalLog } from "./log.ts";

/**
 * 執行 promptfoo 時加的環境變數（bun llm eval 和網頁的評估都用）
 *   PROMPTFOO_ASSERTIONS_MAX_CONCURRENCY：同一筆的標準一條一條評，不同時送好幾個請求給評審模型（promptfoo 預設 3 條同時）
 *   NODE_NO_WARNINGS：promptfoo 會印 Node 的實驗功能警告，跟評估無關
 * 測試資料之間一次一筆、間隔 3 秒，寫在下面的 evaluateOptions
 */
export const PROMPTFOO_ENV = { PROMPTFOO_ASSERTIONS_MAX_CONCURRENCY: "1", NODE_NO_WARNINGS: "1" };

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const short = (s: string) => (s.length > 24 ? `${s.slice(0, 24)}…` : s);

/**
 * 交給評審 AI 的標準：前面補上這次任務收到的輸入。
 * promptfoo 只給評審看任務的輸出；不補的話，要對照輸入才能判斷的標準就評不了。
 */
const forJudge = (criterion: string, input: string) =>
  `你在評估一個 AI 任務的輸出。\n\n【這次任務收到的輸入】\n${input}\n\n【評估標準】針對任務的輸出判斷：\n${criterion}`;

/** 程式判斷：promptfoo 的 javascript 標準，執行 eval.ts 裡同名的函式 */
function checkAssertion(task: Registered, name: string): Assertion {
  const value = async (output: string, ctx: AssertionValueFunctionContext): Promise<GradingResult> => {
    const fn = (await loadChecks(task))[name];
    if (!fn) return { pass: false, score: 0, reason: `eval.ts 裡沒有叫「${name}」的程式判斷` };
    let verdict: Verdict;
    if (task.kind === "oneshot") {
      const input = JSON.parse(String(ctx.vars.input));
      const variant = String(ctx.prompt ?? "main").trim();
      verdict = await fn(task.output ? JSON.parse(output) : output, {
        input,
        run: async (i: unknown) => (await runOneShot(task as never, i as never, { variant })).output,
      });
    } else {
      const meta = (ctx as { providerResponse?: { metadata?: { progress?: unknown } } }).providerResponse?.metadata;
      verdict = await fn({ transcript: output, progress: meta?.progress });
    }
    const v = typeof verdict === "boolean" ? { pass: verdict, reason: verdict ? "通過" : "不通過" } : verdict;
    evalLog(`    程式判斷「${name}」：${v.pass ? "通過" : "不通過"}（${v.reason}）`);
    return { pass: v.pass, score: v.pass ? 1 : 0, reason: v.reason };
  };
  return { type: "javascript", metric: name, value: value as never };
}

/** input 是這一筆的輸入（JSON 字串） */
function toAssertion(task: Registered, c: Criterion, input: string): Assertion {
  // 是非題和評分：promptfoo 會把標準裡的 {{input}} 換成 vars.input。「選最好」不會代換，所以直接把輸入寫進去
  if (c.type === "yesno") return { type: "llm-rubric", metric: short(c.text), value: forJudge(c.text, "{{input}}") };
  if (c.type === "score") return { type: "g-eval", metric: short(c.text), value: forJudge(c.text, "{{input}}"), threshold: c.threshold ?? 0.6 };
  if (c.type === "best") return { type: "select-best", metric: short(c.text), value: forJudge(c.text, input) };
  return checkAssertion(task, c.name);
}

/** 任務的 evals.json → promptfoo 的設定。picked = 只跑這些版本（沒給就是全部） */
export function toPromptfoo(task: Registered, picked?: string[]): UnifiedConfig {
  const evals = readEvals(task);
  const versions = variants(task.dir).filter(v => !picked?.length || picked.includes(v));
  // 「選最好」至少要兩個版本才能比；只有一個版本時拿掉，不然 promptfoo 會直接中止
  const keep = (c: Criterion) => versions.length > 1 || c.type !== "best";
  return {
    description: task.name,
    prompts: versions.map(v => ({ raw: v, label: v })),
    providers: [{ id: `file://${here("./task-provider.ts")}`, label: task.name, config: { task: task.name } }],
    // 供應商有頻率限制：測試資料一次跑一筆，每筆之間隔 3 秒（同一筆的標準一次評一條，見 PROMPTFOO_ENV）
    evaluateOptions: { maxConcurrency: 1, delay: 3000 },
    defaultTest: { options: { provider: { id: `file://${here("./judge-provider.ts")}` } } },
    tests: evals.cases.map(c => {
      const input = JSON.stringify(c.input);
      return {
        description: c.name,
        vars: {
          input,
          ...(task.kind === "dialogue" ? (c.script ? { script: JSON.stringify(c.script) } : { partner: c.partner ?? "", turns: c.turns ?? 0 }) : {}),
        },
        // 每一筆都要過的標準，加上這一筆自己的
        assert: [...evals.criteria, ...(c.criteria ?? [])].filter(keep).map(x => toAssertion(task, x, input)),
      };
    }),
  };
}

/** promptfoo-config.ts 用：用任務名稱找任務 */
export function evalConfig(name: string, picked?: string[]): UnifiedConfig {
  const task = (tasks as Record<string, Registered>)[name];
  if (!task) throw new LLMError("llm_invalid_input", `沒有任務「${name}」`);
  return toPromptfoo(task, picked);
}
