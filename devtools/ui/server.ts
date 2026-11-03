// 網頁介面的後端：bun llm ui（由 dev.ts 啟動；框架程式、index.ts、task.ts 一改，dev.ts 就重啟它）
//   只接受本機連線。編輯檔案、預覽渲染結果不呼叫模型；只有「試跑」送出時才呼叫。
//   .prompt、inputs/*.json 這類不會被 import 的檔案，改了由 /api/events 通知網頁自己更新。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { all } from "../../index.ts";
import type { Registered } from "../../runtime/define.ts";
import { LLMError } from "../../runtime/errors.ts";
import { render, ROOT, SHARED, variants, type PromptOverrides } from "../../runtime/prompt.ts";
import { check, strict } from "../../runtime/schema.ts";
import { createChecksFile } from "../eval/checks.ts";
import { generateCases } from "../eval/generate.ts";
import { judgeModelName, testedModelName } from "../eval/judge.ts";
import { unknownFields } from "../prompt-check.ts";
import { createTask, removeTask, type TaskKind } from "../scaffold.ts";
import { listRuns, loadRun, runMarkdown, runOnce, say, startDialogue } from "./runs.ts";
import { adoptRunning, evalPlan, evalReport, evalResultFile, evalStatus, listEvals, loadEval, saveEvals, startEval, stopEval, type EvalMeta } from "./evals.ts";

const PORT = Number(process.env.UI_PORT ?? 5175);
const tasks = all as Record<string, Registered>;
/** 每次啟動不同：網頁看到它變了，就知道伺服器重啟過、要重新載入任務 */
const BOOT_ID = String(Date.now());

// ─────────────────────────── 檔案 ───────────────────────────
// 網頁上的檔名：
//   main.prompt、main.<版本>.prompt、_<名稱>.prompt   → <任務>/prompts/
//   shared/_<名稱>.prompt                              → shared/prompts/
//   inputs/<名稱>.json                                 → <任務>/inputs/（存起來的輸入，例如不同題目）
//   task.ts、task.test.ts、eval.ts                     → <任務>/（程式，存了伺服器會重啟）

const PROMPT = /^(main(\.[a-z0-9-]+)?|_[a-z0-9-]+)\.prompt$/i;
const SHARED_PROMPT = /^shared\/_[a-z0-9-]+\.prompt$/i;
const INPUT = /^inputs\/[\p{L}\p{N}_-]+\.json$/u;
const CODE = ["task.ts", "task.test.ts", "eval.ts"];

function filePath(task: Registered, file: string): string {
  if (SHARED_PROMPT.test(file)) return join(SHARED, basename(file));
  if (PROMPT.test(file)) return join(task.dir, "prompts", file);
  if (INPUT.test(file)) return join(task.dir, file);
  if (CODE.includes(file)) return join(task.dir, file);
  throw new LLMError("llm_invalid_input", `不能編輯這個檔案：${file}`);
}

const list = (dir: string, ext: string) => (existsSync(dir) ? readdirSync(dir) : []).filter(f => f.endsWith(ext)).sort();

function taskInfo(task: Registered) {
  const own = list(join(task.dir, "prompts"), ".prompt");
  return {
    name: task.name,
    kind: task.kind,
    group: basename(dirname(task.dir)), // "tasks"（正式任務）或 "examples"（範例）
    variants: variants(task.dir),
    files: {
      versions: own.filter(f => f.startsWith("main")).sort((a, b) => (a === "main.prompt" ? -1 : b === "main.prompt" ? 1 : a.localeCompare(b))),
      partials: own.filter(f => f.startsWith("_")),
      shared: list(SHARED, ".prompt").filter(f => f.startsWith("_")).map(f => `shared/${f}`),
      inputs: list(join(task.dir, "inputs"), ".json").map(f => `inputs/${f}`),
      code: CODE.filter(f => existsSync(join(task.dir, f))),
    },
    /** task.ts 的 input（JSON Schema）：網頁用它產生輸入表單 */
    inputSchema: strict(task.input),
    example: task.example,
    state: task.kind === "dialogue" ? task.state() : undefined,
    /** 對話型誰先說話（task.ts 的 opener） */
    opener: task.kind === "dialogue" ? (task.opener ?? "user") : undefined,
  };
}

function taskOf(name: string): Registered {
  const task = tasks[name];
  if (!task) throw new LLMError("llm_invalid_input", `沒有任務「${name}」`);
  return task;
}

/** 網頁給的輸入；沒給就用 task.ts 的 example */
function inputOf(task: Registered, input: unknown) {
  const value = input ?? task.example;
  return { value, errors: check(task.input, value) };
}

// ─────────────────────────── 渲染 ───────────────────────────

interface RenderRequest {
  task: string;
  variant?: string;
  /** 還沒存檔的編輯：{ 檔名: 內容 } */
  edits?: Record<string, string>;
  input?: unknown;
  /** 對話型：第幾輪、狀態 */
  round?: number;
  state?: unknown;
}

async function renderPreview(req: RenderRequest) {
  const task = taskOf(req.task);
  const overrides: PromptOverrides = {};
  for (const [file, content] of Object.entries(req.edits ?? {})) {
    if (file.endsWith(".prompt")) overrides[filePath(task, file)] = content;
  }
  const input = inputOf(task, req.input);
  if (input.errors.length) return { inputErrors: input.errors };

  const data = task.kind === "oneshot"
    ? (input.value as Record<string, unknown>)
    : task.promptInput(input.value, structuredClone(req.state ?? task.state()), req.round ?? 1, []);
  const variant = req.variant ?? "main";
  const rendered = await render(task.dir, data, variant, overrides);
  return { ...rendered, unknown: unknownFields(task.dir, data, variant, overrides), data };
}

// ─────────────────────────── 檔案變動通知 ───────────────────────────

const clients = new Set<ReadableStreamDefaultController>();
const encoder = new TextEncoder();
function broadcast(event: string, data: unknown) {
  const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const c of clients) {
    try { c.enqueue(chunk); } catch { clients.delete(c); }
  }
}

let pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
function changed(path: string) {
  pending.add(relative(ROOT, path));
  clearTimeout(timer);
  timer = setTimeout(() => {
    const paths = [...pending];
    pending = new Set();
    broadcast(paths.some(p => p.endsWith(join("ui", "index.html"))) ? "reload" : "files", { paths });
  }, 150);
}
for (const dir of ["tasks", "examples", join("shared", "prompts"), join("devtools", "ui")]) {
  const full = join(ROOT, dir);
  if (existsSync(full)) watch(full, { recursive: true }, (_e, f) => f && changed(join(full, String(f))));
}

function events(): Response {
  let self: ReadableStreamDefaultController;
  let ping: ReturnType<typeof setInterval>;
  return new Response(new ReadableStream({
    start(controller) {
      self = controller;
      clients.add(controller);
      controller.enqueue(encoder.encode(`event: hello\ndata: ${JSON.stringify({ boot: BOOT_ID })}\n\n`));
      ping = setInterval(() => { try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { clearInterval(ping); } }, 20000);
    },
    cancel() { clients.delete(self); clearInterval(ping); },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

// 伺服器重新啟動前開始的評估：promptfoo 還在跑就接回來，繼續把輸出推給網頁
adoptRunning(
  line => { const st = evalStatus(); if (st.running) broadcast("eval-log", { task: st.meta.task, id: st.meta.id, line }); },
  done => broadcast("eval-done", done),
);

// ─────────────────────────── 呼叫模型：同一時間只有一個 ───────────────────────────
// 試跑、產生測試資料、評估都會呼叫模型。供應商有頻率限制，所以網頁上同一時間只准一件事在呼叫，
// 其他的直接擋下（不排隊），網頁上會看到是誰在用

let calling: string | null = null;

function modelBusy(): string | null {
  const st = evalStatus();
  return st.running ? `${st.meta.task} 的評估` : calling;
}

async function oneAtATime<T>(what: string, run: () => Promise<T>): Promise<T> {
  const busy = modelBusy();
  if (busy) throw new LLMError("llm_invalid_input", `${busy}正在呼叫模型，等它完成再試（同一時間只呼叫一件事，避免超過供應商的頻率限制）`);
  calling = what;
  try {
    return await run();
  } finally {
    calling = null;
  }
}

// ─────────────────────────── 路由 ───────────────────────────

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const body = req.method === "GET" ? {} : ((await req.json().catch(() => ({}))) as Record<string, any>);

  switch (`${req.method} ${url.pathname}`) {
    case "GET /":
      return new Response(Bun.file(join(import.meta.dir, "index.html")));

    case "GET /api/events":
      return events();

    case "GET /api/state":
      return json({
        boot: BOOT_ID,
        model: testedModelName(),
        judge: judgeModelName(),
        keys: Object.keys(process.env).filter(k => /_API_KEY$/.test(k) && process.env[k]).sort(),
        tasks: Object.values(tasks).map(taskInfo),
      });

    // ── 檔案 ──
    case "GET /api/file": {
      const task = taskOf(url.searchParams.get("task") ?? "");
      const path = filePath(task, url.searchParams.get("file") ?? "");
      return json({ content: existsSync(path) ? readFileSync(path, "utf8") : "" });
    }

    case "PUT /api/file": {
      const task = taskOf(body.task);
      const path = filePath(task, body.file);
      if (body.create && existsSync(path)) throw new LLMError("llm_invalid_input", `${body.file} 已經存在`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(body.content ?? ""));
      return json({ ok: true, task: taskInfo(task) });
    }

    case "DELETE /api/file": {
      const task = taskOf(body.task);
      // eval.ts（程式判斷）可有可無，可以刪
      if (body.file === "main.prompt" || (CODE.includes(body.file) && body.file !== "eval.ts")) throw new LLMError("llm_invalid_input", `${body.file} 不能刪除`);
      rmSync(filePath(task, body.file), { force: true });
      return json({ ok: true, task: taskInfo(task) });
    }

    // ── 任務（改了 index.ts，伺服器會自動重啟；網頁收到新的 boot 後重新載入） ──
    case "POST /api/task":
      createTask(String(body.name ?? ""), body.kind === "dialogue" ? "dialogue" : ("oneshot" as TaskKind));
      return json({ ok: true });

    case "DELETE /api/task":
      removeTask(String(body.name ?? ""));
      return json({ ok: true });

    // ── 預覽 ──
    case "POST /api/render":
      return json(await renderPreview(body as RenderRequest));

    // ── 試跑（會呼叫模型）：每次試跑都存在 .runs/，可以回看、接著聊、匯出 ──
    case "POST /api/chat/open": {
      const task = taskOf(body.task);
      if (task.kind !== "dialogue") throw new LLMError("llm_invalid_input", `${task.name} 不是對話型`);
      const input = inputOf(task, body.input);
      if (input.errors.length) throw new LLMError("llm_invalid_input", `輸入不合格：\n- ${input.errors.join("\n- ")}`);
      // AI 先開口的任務，開對話時就會呼叫模型
      return json(await oneAtATime("試跑", () => startDialogue(task, body.variant ?? "main", input.value)));
    }

    case "POST /api/chat/say":
      return json(await oneAtATime("試跑", () => say(taskOf(body.task), String(body.id), String(body.text ?? ""))));

    case "POST /api/run": {
      const task = taskOf(body.task);
      if (task.kind !== "oneshot") throw new LLMError("llm_invalid_input", `${task.name} 不是單次型`);
      return json(await oneAtATime("試跑", () => runOnce(task, body.variant ?? "main", body.input)));
    }

    // ── 評估（會呼叫模型很多次）：交給 promptfoo，輸出用 /api/events 即時推給網頁 ──
    case "GET /api/eval/plan":
      return json(await evalPlan(taskOf(url.searchParams.get("task") ?? "")));

    // 存測試資料和標準（evals.json）；不合格就整個不存，錯誤列給網頁看
    case "PUT /api/eval/plan":
      return json(await saveEvals(taskOf(body.task), body.evals));

    // 讓 AI 依任務的輸入格式產生測試資料（會呼叫評審模型）。只回傳給網頁，按「儲存」才寫進 evals.json
    case "POST /api/eval/generate":
      return json(await oneAtATime("產生測試資料", () => generateCases(taskOf(body.task), {
        count: Number(body.count ?? 3),
        hint: typeof body.hint === "string" ? body.hint : undefined,
        existing: Array.isArray(body.existing) ? body.existing.map(String) : [],
      })));

    // 建立 eval.ts（寫程式判斷用）。程式檔一建立，伺服器會重啟
    case "POST /api/eval/checks":
      createChecksFile(taskOf(body.task));
      return json({ ok: true });

    case "POST /api/eval/start": {
      const task = taskOf(body.task);
      // 試跑、產生進行中不能開始評估；評估開始後（evalStatus().running），oneAtATime 會擋下試跑和產生
      const meta: EvalMeta = await oneAtATime("開始評估", () => startEval(task, { variants: body.variants, cases: body.cases },
        line => broadcast("eval-log", { task: task.name, id: meta.id, line }),
        done => broadcast("eval-done", done)));
      return json(meta);
    }

    case "POST /api/eval/stop":
      return json({ stopped: stopEval() });

    case "GET /api/eval/status":
      return json(evalStatus());

    case "GET /api/evals":
      return json(listEvals(taskOf(url.searchParams.get("task") ?? "").name));

    case "GET /api/eval": {
      const task = taskOf(url.searchParams.get("task") ?? "").name;
      const id = url.searchParams.get("id") ?? "";
      const format = url.searchParams.get("format");
      if (!format) return json(loadEval(task, id));
      // html：promptfoo 的報表，在新分頁打開；row=第幾筆（0 起算）只看那一筆；加 download=1 是匯出（下載）
      const row = url.searchParams.get("row");
      const [content, type, ext] = format === "html"
        ? [evalReport(task, id, row === null ? undefined : Number(row)), "text/html; charset=utf-8", "html"]
        : [evalResultFile(task, id), "application/json; charset=utf-8", "json"];
      const download = format === "json" || url.searchParams.get("download") === "1";
      return new Response(content, { headers: { "Content-Type": type, ...(download ? { "Content-Disposition": `attachment; filename="${task}-eval-${id}.${ext}"` } : {}) } });
    }

    case "GET /api/runs":
      return json(listRuns(taskOf(url.searchParams.get("task") ?? "").name));

    case "GET /api/run": {
      const record = loadRun(taskOf(url.searchParams.get("task") ?? "").name, url.searchParams.get("id") ?? "");
      const format = url.searchParams.get("format");
      if (!format) return json(record);
      const [body, type, ext] = format === "md"
        ? [runMarkdown(record), "text/markdown; charset=utf-8", "md"]
        : [JSON.stringify(record, null, 2), "application/json; charset=utf-8", "json"];
      return new Response(body, { headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${record.task}-${record.id}.${ext}"` } });
    }
  }
  return json({ error: "找不到這個網址" }, 404);
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0, // 檔案變動通知是長連線，呼叫模型也可能超過預設的 10 秒
  async fetch(req) {
    try {
      return await handle(req);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof LLMError ? e.status : 500);
    }
  },
});

console.log(`
  llm-framework 網頁介面已啟動
  ➜ 請用瀏覽器開啟 http://127.0.0.1:${PORT}
  ➜ 只接受本機連線；改了框架程式或 task.ts 會自動重啟；按 Ctrl+C 結束
`);
