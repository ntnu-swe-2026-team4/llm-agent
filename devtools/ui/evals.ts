// 網頁上的評估：編輯任務的 evals.json、交給 promptfoo 跑、把結果整理成表格
//   每次評估一個資料夾 .runs/<任務>/evals/<編號>/：meta.json（設定、狀態）、log.txt（promptfoo 的輸出）、result.json（promptfoo 的結果）
//   同一時間只跑一個評估
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Registered } from "../../runtime/define.ts";
import { LLMError } from "../../runtime/errors.ts";
import { ROOT, variants } from "../../runtime/prompt.ts";
import { checksPath, loadChecks } from "../eval/checks.ts";
import { checkEvals, readEvals, writeEvals, type EvalFile } from "../eval/evals-file.ts";
import { judgeModelName, testedModelName } from "../eval/judge.ts";
import { PROMPTFOO_ENV } from "../eval/promptfoo.ts";

const RUNS = join(ROOT, ".runs");
const dirOf = (task: string, id: string) => join(RUNS, task, "evals", id);
const ID = /^[\w-]+$/;

// ─────────────────────────── 評估內容（evals.json） ───────────────────────────

/** 網頁編輯評估要的全部：測試資料和標準、版本、eval.ts 裡有哪些程式判斷 */
export async function evalPlan(task: Registered) {
  return {
    model: testedModelName(),
    judge: judgeModelName(),
    variants: variants(task.dir),
    evals: readEvals(task),
    hasChecksFile: existsSync(checksPath(task)),
    checks: Object.keys(await loadChecks(task)),
  };
}

export async function saveEvals(task: Registered, data: EvalFile) {
  writeEvals(task, data, Object.keys(await loadChecks(task)));
  return evalPlan(task);
}

// ─────────────────────────── 執行 ───────────────────────────

export interface EvalMeta {
  id: string;
  task: string;
  model: string;
  judge: string;
  /** 只跑這些版本、這些測試資料（沒有就是全部） */
  variants?: string[];
  cases?: string[];
  status: "running" | "done" | "failed" | "stopped";
  startedAt: string;
  seconds?: number;
  /** promptfoo 的程序編號；它自成一個程序群組，停止時整組砍掉（npx 和它開的 promptfoo 一起） */
  pid?: number;
  /** 按過「停止」 */
  stopRequested?: boolean;
  /** 為什麼停（例如伺服器重新啟動時它已經不在了） */
  note?: string;
}

/**
 * 正在跑的評估。promptfoo 的輸出直接寫進 log.txt，這裡每半秒讀新增的部分推給網頁、檢查程序還在不在。
 * 不靠父子程序的管線：網頁伺服器重新啟動時，promptfoo 照樣跑，新的伺服器啟動後接回來（adoptRunning）
 */
let job: { meta: EvalMeta; offset: number; rest: string; timer: ReturnType<typeof setInterval>; onLog: (line: string) => void; onDone: (meta: EvalMeta) => void } | null = null;

const POLL_MS = 500;
const alive = (pid: number) => {
  try {
    process.kill(-pid, 0); // 負號 = 整個程序群組，裡面還有任何程序就算活著
    return true;
  } catch {
    return false;
  }
};
const elapsed = (m: EvalMeta) => Math.round((Date.now() - Date.parse(m.startedAt)) / 100) / 10;
const logFile = (m: EvalMeta) => join(dirOf(m.task, m.id), "log.txt");

/** 讀 log.txt 新增的部分，一行一行交給 onLog（最後沒換行的半行留到下次） */
function pump() {
  if (!job) return;
  const f = logFile(job.meta);
  if (!existsSync(f)) return;
  const buf = readFileSync(f);
  if (buf.length <= job.offset) return;
  const text = job.rest + buf.subarray(job.offset).toString("utf8");
  job.offset = buf.length;
  const lines = text.split(/\r?\n/);
  job.rest = lines.pop() ?? "";
  for (const line of lines) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
    if (clean.trim()) job.onLog(clean);
  }
}

function watchJob(meta: EvalMeta, onLog: (line: string) => void, onDone: (meta: EvalMeta) => void, offset = 0) {
  const timer = setInterval(() => {
    pump();
    if (meta.pid && alive(meta.pid)) return;
    // 程序結束了：收尾
    pump();
    clearInterval(timer);
    job = null;
    meta.seconds = elapsed(meta);
    // 有測試沒過時 promptfoo 也會用非 0 結束，所以看有沒有產生結果檔
    meta.status = meta.stopRequested ? "stopped" : existsSync(join(dirOf(meta.task, meta.id), "result.json")) ? "done" : "failed";
    saveMeta(meta);
    onDone(meta);
  }, POLL_MS);
  job = { meta, offset, rest: "", timer, onLog, onDone };
}

function newId() {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactly = (names: string[]) => `^(${names.map(escapeRe).join("|")})$`;
const saveMeta = (m: EvalMeta) => writeFileSync(join(dirOf(m.task, m.id), "meta.json"), JSON.stringify(m, null, 2));

export async function startEval(
  task: Registered,
  pick: { variants?: string[]; cases?: string[] },
  onLog: (line: string) => void,
  onDone: (meta: EvalMeta) => void,
): Promise<EvalMeta> {
  if (job) throw new LLMError("llm_invalid_input", `已經有一個評估在跑（${job.meta.task}），請等它跑完或按「停止」`);
  const evals = readEvals(task);
  // 例如 task.ts 的 input 改了，舊的測試資料對不上：先擋下，不然要跑到一半才知道
  const errors = checkEvals(task, evals, Object.keys(await loadChecks(task)));
  if (errors.length) throw new LLMError("llm_invalid_input", `評估內容有問題，先修好再開始：\n- ${errors.join("\n- ")}`);
  const names = evals.cases.map(c => c.name);
  if (!names.length) throw new LLMError("llm_invalid_input", `${task.name} 還沒有測試資料`);
  const missing = (pick.cases ?? []).filter(c => !names.includes(c));
  if (missing.length) throw new LLMError("llm_invalid_input", `沒有這些測試資料：${missing.join("、")}`);

  const meta: EvalMeta = { id: newId(), task: task.name, model: testedModelName(), judge: judgeModelName(), variants: pick.variants, cases: pick.cases, status: "running", startedAt: new Date().toISOString() };
  const dir = dirOf(task.name, meta.id);
  mkdirSync(dir, { recursive: true });
  saveMeta(meta);

  const config = join(ROOT, "devtools", "eval", "promptfoo-config.ts");
  // 結果存兩份：result.json（完整資料）、result.html（promptfoo 自己產生的報表，網頁的結果頁直接顯示它）
  const args = ["promptfoo", "eval", "-c", config, "-o", join(dir, "result.json"), join(dir, "result.html"), "--no-table", "--no-progress-bar"];
  if (pick.cases?.length) args.push("--filter-pattern", exactly(pick.cases));
  // 任務和版本用環境變數交給 eval-config.ts（它要知道有幾個版本，才決定「選最好」能不能比）
  const env = { ...process.env, ...PROMPTFOO_ENV, LLM_EVAL_TASK: task.name, LLM_EVAL_VARIANTS: (pick.variants ?? []).join(",") };

  // detached：自成一個程序群組，停止時才能連 npx 開出來的 promptfoo 一起砍；輸出直接寫進 log.txt
  const out = openSync(logFile(meta), "a");
  try {
    const proc = spawn("npx", args, { cwd: ROOT, env, detached: true, stdio: ["ignore", out, out] });
    proc.on("error", e => appendFileSync(logFile(meta), `執行 promptfoo 失敗（需要 Node.js，終端機要找得到 npx）：${e.message}\n`));
    proc.unref();
    meta.pid = proc.pid;
  } finally {
    closeSync(out);
  }
  saveMeta(meta);
  watchJob(meta, onLog, onDone);
  return meta;
}

/** 停止：整個程序群組先送 SIGTERM，3 秒後還在就 SIGKILL。真的結束後 watchJob 會把狀態記成「已停止」 */
export function stopEval() {
  if (!job?.meta.pid) return false;
  const { meta } = job;
  meta.stopRequested = true;
  saveMeta(meta);
  const pid = meta.pid!;
  try { process.kill(-pid, "SIGTERM"); } catch {}
  setTimeout(() => { if (alive(pid)) try { process.kill(-pid, "SIGKILL"); } catch {} }, 3000);
  return true;
}

/**
 * 網頁伺服器啟動時呼叫：找出紀錄上還是「進行中」的評估。
 * promptfoo 還在跑就接回來（繼續轉送輸出）；已經不在了就記成「已停止」，不會一直卡在進行中
 */
export function adoptRunning(onLog: (line: string) => void, onDone: (meta: EvalMeta) => void) {
  if (!existsSync(RUNS)) return;
  for (const task of readdirSync(RUNS)) {
    const dir = join(RUNS, task, "evals");
    if (!existsSync(dir)) continue;
    for (const id of readdirSync(dir)) {
      const f = join(dir, id, "meta.json");
      if (!existsSync(f)) continue;
      const meta = JSON.parse(readFileSync(f, "utf8")) as EvalMeta;
      if (meta.status !== "running") continue;
      if (meta.pid && alive(meta.pid) && !job) {
        const size = existsSync(logFile(meta)) ? readFileSync(logFile(meta)).length : 0;
        watchJob(meta, onLog, onDone, size);
        continue;
      }
      meta.status = existsSync(join(dir, id, "result.json")) ? "done" : "stopped";
      meta.note = meta.status === "stopped" ? "網頁伺服器重新啟動時，這次評估已經中斷" : undefined;
      saveMeta(meta);
    }
  }
}

export function evalStatus() {
  if (!job) return { running: false as const };
  return { running: true as const, meta: job.meta, seconds: elapsed(job.meta), log: readLog(job.meta.task, job.meta.id) };
}

// ─────────────────────────── 結果 ───────────────────────────

const readLog = (task: string, id: string) => {
  const f = join(dirOf(task, id), "log.txt");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

/** promptfoo 的 failureReason：1 = 有標準沒過，2 = 執行出錯（例如呼叫模型失敗）。沒過不是錯誤 */
const FAILURE_ERROR = 2;

/** 每個版本：通過幾格、沒過幾格、執行出錯幾格（評估紀錄清單上的一行摘要；細節看 promptfoo 的報表） */
function summarize(task: string, id: string) {
  const f = join(dirOf(task, id), "result.json");
  if (!existsSync(f)) return [];
  const data = JSON.parse(readFileSync(f, "utf8"));
  const list: { prompt?: { label?: string }; success?: boolean; failureReason?: number; testCase?: { description?: string } }[] = data.results?.results ?? [];
  const variants = [...new Set(list.map(r => String(r.prompt?.label ?? "")))];
  return variants.map(v => {
    const mine = list.filter(r => String(r.prompt?.label ?? "") === v);
    // 執行出錯的格子是哪幾筆測試資料：網頁上「重跑出錯的」只跑這些
    const errorCases = mine.filter(r => r.failureReason === FAILURE_ERROR).map(r => String(r.testCase?.description ?? ""));
    const passed = mine.filter(r => r.success).length;
    return { variant: v, total: mine.length, passed, failed: mine.length - passed - errorCases.length, errors: errorCases.length, errorCases };
  });
}

function loadMeta(task: string, id: string): EvalMeta {
  const f = join(dirOf(task, id), "meta.json");
  if (!ID.test(id) || !existsSync(f)) throw new LLMError("llm_invalid_input", `找不到評估紀錄 ${id}`);
  return JSON.parse(readFileSync(f, "utf8")) as EvalMeta;
}

export function listEvals(task: string) {
  const dir = join(RUNS, task, "evals");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(id => existsSync(join(dir, id, "meta.json")))
    .map(id => {
      const meta = loadMeta(task, id);
      return { ...meta, summary: summarize(task, id) };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** 報表裡每一列是哪一筆測試資料（promptfoo 照設定裡 tests 的順序排列） */
function rowNames(task: string, id: string): string[] {
  const f = join(dirOf(task, id), "result.json");
  if (!existsSync(f)) return [];
  const data = JSON.parse(readFileSync(f, "utf8"));
  const tested = new Set((data.results?.results ?? []).map((r: { testIdx?: number }) => r.testIdx));
  return ((data.config?.tests ?? []) as { description?: string }[])
    .map((t, i) => ({ name: String(t.description ?? `第 ${i + 1} 筆`), i }))
    .filter(t => tested.has(t.i)) // 只跑部分測試資料時，沒跑的不會出現在報表裡
    .map(t => t.name);
}

export function loadEval(task: string, id: string) {
  const meta = loadMeta(task, id);
  const hasResult = existsSync(join(dirOf(task, id), "result.json"));
  return { meta, summary: summarize(task, id), rows: rowNames(task, id), hasResult, log: readLog(task, id) };
}

export function evalResultFile(task: string, id: string) {
  loadMeta(task, id);
  const f = join(dirOf(task, id), "result.json");
  if (!existsSync(f)) throw new LLMError("llm_invalid_input", "這次評估沒有產生結果");
  return readFileSync(f, "utf8");
}

/**
 * promptfoo 產生的 HTML 報表。這個功能加上去之前跑的評估沒有 result.html：
 * 用 promptfoo export 從它自己的紀錄補產生（不呼叫模型）。
 * row：只留第幾列（0 起算）。對話型每格是整段對話，全部放一頁太長，所以每一筆可以單獨打開；樣式和功能都是 promptfoo 原本的
 */
export function evalReport(task: string, id: string, row?: number) {
  const html = readable(fullReport(task, id));
  if (row === undefined) return html;
  const start = html.indexOf("<tbody>");
  const end = html.indexOf("</tbody>", start);
  if (start < 0 || end < 0) throw new LLMError("llm_invalid_input", "報表的格式跟預期的不一樣，沒辦法單獨打開一筆");
  const rows = html.slice(start + "<tbody>".length, end).split(/(?=<tr data-result-row>)/).filter(s => s.includes("data-result-row"));
  if (!rows[row]) throw new LLMError("llm_invalid_input", `報表裡沒有第 ${row + 1} 筆`);
  const name = rowNames(task, id)[row];
  return (html.slice(0, start + "<tbody>".length) + "\n" + rows[row] + html.slice(end))
    .replace(/<title>[^<]*<\/title>/, `<title>${task}｜${(name ?? `第 ${row + 1} 筆`).replace(/[<&]/g, "")}</title>`);
}

/**
 * 送出報表前加一段樣式和程式（不改 promptfoo 的檔案，result.html 還是原本的）：
 *   - 每格輸出限制高度、格子裡自己捲動，按「展開全部」才整段攤開
 *   - 對話型的輸出（「AI：」「對方：」開頭的行）切成一句一個區塊，兩邊不同底色
 */
const READABLE = `
<style>
  .output-text.clamped { max-height: 340px; overflow: auto; }
  .output-text .turn { white-space: pre-wrap; padding: 6px 10px; border-radius: 8px; margin: 0 0 6px; }
  .output-text .turn-ai { background: #eaf1fb; margin-right: 24px; }
  .output-text .turn-other { background: #f1f1ee; margin-left: 24px; }
  .clamp-toggle { margin: 6px 0 0; padding: 2px 10px; border: 1px solid #d8deea; border-radius: 6px; background: #fff; cursor: pointer; font: inherit; font-size: 12px; }
</style>
<script>
  document.addEventListener("DOMContentLoaded", () => {
    for (const el of document.querySelectorAll(".output-text")) {
      const text = el.textContent;
      if (/^(AI|對方)：/m.test(text)) {
        el.textContent = "";
        for (const turn of text.split(/\\n(?=(?:AI|對方)：)/)) {
          const div = document.createElement("div");
          div.className = "turn " + (turn.startsWith("AI：") ? "turn-ai" : "turn-other");
          div.textContent = turn.trim();
          el.appendChild(div);
        }
      }
      el.classList.add("clamped");
      if (el.scrollHeight <= el.clientHeight + 4) { el.classList.remove("clamped"); continue; }
      const button = document.createElement("button");
      button.className = "clamp-toggle";
      button.textContent = "展開全部";
      button.onclick = () => { button.textContent = el.classList.toggle("clamped") ? "展開全部" : "收起來"; };
      el.after(button);
    }
  });
</script>
`;
const readable = (html: string) => html.replace("</head>", `${READABLE}</head>`);

function fullReport(task: string, id: string) {
  const dir = dirOf(task, id);
  const html = join(dir, "result.html");
  if (!existsSync(html)) {
    const evalId = JSON.parse(evalResultFile(task, id)).evalId as string | undefined;
    if (!evalId) throw new LLMError("llm_invalid_input", "這次評估的結果裡沒有 promptfoo 的評估編號，產生不了報表");
    const r = spawnSync("npx", ["promptfoo", "export", "eval", evalId, "-o", html], { cwd: ROOT, env: { ...process.env, ...PROMPTFOO_ENV }, encoding: "utf8" });
    if (!existsSync(html)) throw new LLMError("llm_invalid_input", `產生報表失敗：${(r.stderr || r.stdout || r.error?.message || "").trim().slice(-300)}`);
  }
  return readFileSync(html, "utf8");
}
