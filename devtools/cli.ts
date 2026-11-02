// LLM 組的指令：bun llm <指令>
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { all, examples, tasks } from "../index.ts";
import { connection, describe } from "../runtime/config.ts";
import type { DialogueTask, OneShotTask, Registered } from "../runtime/define.ts";
import { reply, type HistoryMessage } from "../runtime/dialogue.ts";
import { LLMError } from "../runtime/errors.ts";
import { camel } from "../runtime/llm.ts";
import { answer } from "../runtime/oneshot.ts";
import { renderTask } from "../runtime/prepare.ts";
import { ROOT, variants } from "../runtime/prompt.ts";
import { readEvals } from "./eval/evals-file.ts";
import { PROMPTFOO_ENV } from "./eval/promptfoo.ts";
import { createTask } from "./scaffold.ts";

const HELP = `用法：bun llm <指令>

  render <任務> [版本]       印出送給 AI 的 prompt（不呼叫模型）
  try <任務> [版本]          用範例輸入呼叫模型跑一次；對話型會在終端機裡對話
  eval <任務>                AI 評估：評審 AI 幫每個 prompt 版本打分（題目和檢查在網頁的「比較版本」編輯）
  view                       用 promptfoo 自己的網頁看評估結果
  new <任務> [--dialogue]    建立新的任務（預設單次型）
  ui                         開啟網頁介面：編輯 prompt、試跑、評估

<任務> 可以是正式任務或範例。
正式任務（tasks/）：${Object.keys(tasks).join("、") || "還沒有，用 bun llm new 建立"}
範例（examples/）：${Object.keys(examples).join("、")}`;

const fail = (message: string): never => {
  console.log(`❌ ${message}`);
  process.exit(1);
};

function taskArg(name: string | undefined): Registered {
  if (!name) fail(`請指定任務\n\n${HELP}`);
  const task = (all as Record<string, Registered>)[name!];
  return task ?? fail(`沒有任務「${name}」，現有任務與範例：${Object.keys(all).join("、")}`);
}

function variantArg(task: Registered, variant: string | undefined) {
  if (variant && !variants(task.dir).includes(variant)) fail(`沒有版本「${variant}」，現有版本：${variants(task.dir).join("、")}`);
  return variant;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

async function render(name?: string, variant?: string) {
  const task = taskArg(name);
  variant = variantArg(task, variant);
  const r = await renderTask(task, task.example, { variant });
  console.log(`── ${task.name}　版本：${variant ?? "main"}　（現有版本：${variants(task.dir).join("、")}）`);
  console.log(`\n[system]\n${r.system}`);
  if (r.user) console.log(`\n[user]\n${r.user}`);
}

async function tryOneShot(task: Registered<OneShotTask>, variant?: string) {
  console.log(`── 輸入（task.ts 的 example）\n${json(task.example)}\n\n呼叫模型中（${describe(connection())}）…`);
  const run = answer(task, task.example as never, { variant });
  if (!task.output) {
    console.log("\n── 輸出");
    for await (const text of run) process.stdout.write(text); // 逐段印出
    console.log();
    return;
  }
  const { output, stats } = await run.result;
  console.log(`\n── 輸出\n${json(output)}\n\n（格式不對、重問了 ${stats.retries} 次）`);
}

/** 對話型：對話紀錄和狀態由這裡保存，每一輪連同新的話一起交給框架（跟後端的用法一樣） */
async function tryDialogue(task: Registered<DialogueTask>, variant?: string) {
  console.log(`── ${task.name}（${describe(connection())}）：輸入你的話按 Enter，空白行結束\n`);
  const history: HistoryMessage[] = [];
  let state: unknown;

  const aiSays = async () => {
    process.stdout.write("AI：");
    const turn = reply(task, task.example as never, { history, state }, { variant });
    for await (const text of turn) process.stdout.write(text); // 逐段印出
    const result = await turn.result;
    state = result.state;
    history.push({ role: "assistant", text: result.text });
    console.log(`\n    進度：${JSON.stringify(result.progress)}\n`);
  };

  if (task.opener === "ai") await aiSays();
  const rl = createInterface({ input: process.stdin });
  process.stdout.write("你：");
  try {
    for await (const line of rl) {
      if (!line.trim()) break;
      history.push({ role: "user", text: line.trim() });
      await aiSays();
      process.stdout.write("你：");
    }
  } finally {
    rl.close();
  }
}

async function tryTask(name?: string, variant?: string) {
  const task = taskArg(name);
  variant = variantArg(task, variant);
  if (task.kind === "oneshot") await tryOneShot(task as Registered<OneShotTask>, variant);
  else await tryDialogue(task as Registered<DialogueTask>, variant);
}

function promptfoo(args: string[]) {
  const r = spawnSync("npx", ["promptfoo", ...args], { cwd: ROOT, stdio: "inherit" });
  if (r.error) fail(`執行 promptfoo 失敗（需要 Node.js）：${r.error.message}`);
  process.exitCode = r.status ?? 1;
}

function evalTask(name?: string, extra: string[] = []) {
  const task = taskArg(name);
  if (!readEvals(task).cases.length) fail(`${task.name} 還沒有比較用的題目：在網頁（bun llm ui）的「比較版本」新增`);
  // 設定檔讀 LLM_EVAL_TASK，知道要評估哪個任務；PROMPTFOO_ENV 讓評分一條一條送
  Object.assign(process.env, PROMPTFOO_ENV, { LLM_EVAL_TASK: task.name });
  promptfoo(["eval", "-c", join(ROOT, "devtools", "eval", "promptfoo-config.ts"), ...extra]);
  console.log("\n看結果：bun llm view，或網頁的「比較版本」");
}

function create(name?: string, kindFlag?: string) {
  if (!name) fail("請給任務名稱，例：bun llm new argument-summary");
  const kind = kindFlag === "--dialogue" ? "dialogue" : "oneshot";
  createTask(name!, kind);

  console.log(`已建立 tasks/${name}/（${kind === "dialogue" ? "對話型" : "單次型"}），並註冊到 index.ts → llm.${camel(name!)}()

接下來：
  1. task.ts                改輸入、輸出格式和範例
  2. prompts/main.prompt    寫 prompt              → bun llm render ${name}
  3. 呼叫模型試跑                                   → bun llm try ${name}
  4. task.test.ts           這個任務自己的測試      → bun run check
  5. 比較版本（題目和檢查）  網頁的「比較版本」分頁  → bun llm ui`);
}

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case "render": await render(args[0], args[1]); break;
    case "try": await tryTask(args[0], args[1]); break;
    case "eval": evalTask(args[0], args.slice(1)); break;
    case "view": promptfoo(["view"]); break;
    case "new": create(args[0], args[1]); break;
    // 守門程式：.ts 或 .env 改了就重啟網頁伺服器（.prompt 檔的變動由網頁自己更新）
    case "ui": process.exitCode = spawnSync(process.execPath, [join(ROOT, "devtools", "ui", "dev.ts")], { cwd: ROOT, stdio: "inherit" }).status ?? 0; break;
    default: console.log(HELP);
  }
} catch (e) {
  if (e instanceof LLMError) fail(`${e.message}（${e.code}）`);
  throw e;
}
