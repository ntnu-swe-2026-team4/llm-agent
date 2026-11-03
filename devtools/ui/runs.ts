// 試跑紀錄：每次試跑一個資料夾 .runs/<任務>/<編號>/run.json（不進 git）
//   存設定、輸入、每一輪實際用的 system prompt、每則對話和花了幾秒、進度、任務狀態
// 接著聊：框架不記狀態，所以從紀錄裡的對話和狀態組回去，連同新的一句交給框架（跟後端的用法一樣）
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DialogueTask, OneShotTask, Registered } from "../../runtime/define.ts";
import { reply, type HistoryMessage } from "../../runtime/dialogue.ts";
import { LLMError } from "../../runtime/errors.ts";
import { runOneShot, type OneShotStats } from "../../runtime/oneshot.ts";
import { renderTask } from "../../runtime/prepare.ts";
import { ROOT } from "../../runtime/prompt.ts";
import { testedModelName } from "../eval/judge.ts";

const RUNS = join(ROOT, ".runs");

export interface Turn {
  round: number;
  /** 使用者說的話；null = 這一輪是 AI 先開口（任務宣告 opener: "ai"） */
  user: string | null;
  reply?: string;
  error?: string;
  /** AI 花了幾秒 */
  seconds: number;
  /** 這一輪 AI 回覆時實際用的 system prompt（工具改了狀態的話，是重新渲染後的版本） */
  systemPrompt: string;
  progress?: unknown;
  at: string;
}

export interface RunRecord {
  id: string;
  task: string;
  kind: "dialogue" | "oneshot";
  variant: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  input: unknown;
  /** .prompt 檔頭的 config（temperature 等） */
  config: Record<string, unknown>;
  // ── 對話型 ──
  /** 第一則訊息前面的背景資料（main.prompt 的 user 段落） */
  context?: string;
  turns?: Turn[];
  /** 最後一輪成功後的任務狀態，接著聊時傳回框架 */
  state?: unknown;
  // ── 單次型 ──
  systemPrompt?: string;
  userPrompt?: string;
  output?: unknown;
  stats?: OneShotStats;
  seconds?: number;
  error?: string;
}

const ID = /^[\w-]+$/;
const dirOf = (task: string, id: string) => join(RUNS, task, id);
const now = () => new Date().toISOString();
const secondsSince = (t0: number) => Math.round((performance.now() - t0) / 100) / 10;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function newId() {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

function save(r: RunRecord) {
  r.updatedAt = now();
  mkdirSync(dirOf(r.task, r.id), { recursive: true });
  writeFileSync(join(dirOf(r.task, r.id), "run.json"), JSON.stringify(r, null, 2));
}

export function loadRun(task: string, id: string): RunRecord {
  const file = join(dirOf(task, id), "run.json");
  if (!ID.test(id) || !existsSync(file)) throw new LLMError("llm_invalid_input", `找不到試跑紀錄 ${id}`);
  return JSON.parse(readFileSync(file, "utf8")) as RunRecord;
}

/** 這個任務的試跑紀錄，新的在前 */
export function listRuns(task: string) {
  const dir = join(RUNS, task);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(id => existsSync(join(dir, id, "run.json")))
    .map(id => loadRun(task, id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(r => ({
      id: r.id,
      kind: r.kind,
      variant: r.variant,
      model: r.model,
      createdAt: r.createdAt,
      rounds: r.turns?.length ?? 0,
      first: r.kind === "dialogue"
        ? (r.turns?.find(t => t.user)?.user ?? (r.turns?.length ? "（只有 AI 的開場白）" : "（還沒開始）"))
        : JSON.stringify(r.input).slice(0, 60),
      error: Boolean(r.error || r.turns?.some(t => t.error)),
    }));
}

// ─────────────────────────── 對話型 ───────────────────────────

/** 紀錄裡成功的那幾輪 → 對話紀錄（出錯的那一輪不算，跟後端「成功才存」一樣） */
function historyOf(record: RunRecord): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  for (const t of record.turns ?? []) {
    if (t.error) continue;
    if (t.user !== null) history.push({ role: "user", text: t.user });
    history.push({ role: "assistant", text: t.reply ?? "" });
  }
  return history;
}

/** 跑一輪：text 是使用者這一輪說的話；null = AI 先開口 */
async function runTurn(task: Registered<DialogueTask>, record: RunRecord, text: string | null) {
  const history = historyOf(record);
  if (text !== null) history.push({ role: "user", text });
  const round = history.filter(m => m.role === "assistant").length + 1;

  // 先算出這一輪一開始會送的 prompt（用狀態的複本算，不影響真正的對話）；出錯時存這一版
  const r = await renderTask(task, record.input, { variant: record.variant, state: structuredClone(record.state ?? task.state()), round, history });
  if (round === 1 && r.user) record.context = r.user;
  record.config = r.config;

  const t0 = performance.now();
  const turn: Turn = { round, user: text, seconds: 0, systemPrompt: r.system, at: now() };
  try {
    const result = await reply(task, record.input as never, { history, state: record.state }, { variant: record.variant }).result;
    // AI 回覆時實際用的 prompt：工具改了狀態後會重新渲染，所以用回覆完的狀態再算一次
    const final = await renderTask(task, record.input, { variant: record.variant, state: structuredClone(result.state), round, history });
    Object.assign(turn, { reply: result.text, progress: result.progress, systemPrompt: final.system });
    record.state = result.state;
    return { reply: result.text, seconds: (turn.seconds = secondsSince(t0)), progress: result.progress, round, systemPrompt: final.system };
  } catch (e) {
    turn.error = errorText(e);
    turn.seconds = secondsSince(t0);
    throw e;
  } finally {
    record.turns!.push(turn);
    save(record);
  }
}

/** 開一段新對話。任務宣告 opener: "ai" 的話，這裡就會呼叫模型，AI 的開場白記成第 1 輪 */
export async function startDialogue(task: Registered, variant: string, input: unknown): Promise<RunRecord> {
  const t = now();
  const record: RunRecord = { id: newId(), task: task.name, kind: "dialogue", variant, model: testedModelName(), createdAt: t, updatedAt: t, input, config: {}, turns: [] };
  const dialogue = task as Registered<DialogueTask>;
  if (dialogue.opener === "ai") await runTurn(dialogue, record, null);
  else save(record);
  return record;
}

export async function say(task: Registered, id: string, text: string) {
  return runTurn(task as Registered<DialogueTask>, loadRun(task.name, id), text);
}

// ─────────────────────────── 單次型 ───────────────────────────

export async function runOnce(task: Registered, variant: string, input: unknown): Promise<RunRecord> {
  const t = now();
  const record: RunRecord = { id: newId(), task: task.name, kind: "oneshot", variant, model: testedModelName(), createdAt: t, updatedAt: t, input, config: {} };
  const r = await renderTask(task, input, { variant });
  Object.assign(record, { systemPrompt: r.system, userPrompt: r.user, config: r.config });

  const t0 = performance.now();
  try {
    const { output, stats } = await runOneShot(task as Registered<OneShotTask>, input as never, { variant });
    Object.assign(record, { output, stats, seconds: secondsSince(t0) });
    return record;
  } catch (e) {
    Object.assign(record, { error: errorText(e), seconds: secondsSince(t0) });
    throw e;
  } finally {
    save(record);
  }
}

// ─────────────────────────── 匯出 ───────────────────────────

const fence = (lang: string, text: string) => `\`\`\`${lang}\n${text}\n\`\`\``;

export function runMarkdown(r: RunRecord): string {
  const temp = typeof r.config.temperature === "number" ? String(r.config.temperature) : "模型預設";
  const lines = [
    `# 試跑紀錄 ${r.id}`,
    "",
    `- 任務：${r.task}（${r.kind === "dialogue" ? "對話型" : "單次型"}）`,
    `- 版本：${r.variant}`,
    `- 模型：${r.model}`,
    `- temperature：${temp}`,
    `- 開始：${r.createdAt}`,
    `- 最後更新：${r.updatedAt}`,
    "",
    "## 輸入",
    "",
    fence("json", JSON.stringify(r.input, null, 2)),
    "",
  ];
  if (r.kind === "dialogue") {
    if (r.context) lines.push("## 背景資料（main.prompt 的 user 段落，放在對話最前面）", "", fence("", r.context), "");
    lines.push("## 對話", "");
    for (const t of r.turns ?? []) {
      lines.push(`### 第 ${t.round} 輪`, "", t.user === null ? "（AI 先開口）" : `**使用者**：${t.user}`, "");
      if (t.error) lines.push(`**錯誤**（${t.seconds} 秒）：${t.error}`, "");
      else lines.push(`**AI**（${t.seconds} 秒）：${t.reply}`, "", `進度：\`${JSON.stringify(t.progress)}\``, "");
      lines.push("<details><summary>這一輪的 system prompt</summary>", "", fence("", t.systemPrompt), "", "</details>", "");
    }
  } else {
    lines.push("## 送出的 prompt", "", "**system**", "", fence("", r.systemPrompt ?? ""), "");
    if (r.userPrompt) lines.push("**user**", "", fence("", r.userPrompt), "");
    lines.push(`## 結果（${r.seconds} 秒）`, "");
    if (r.error) lines.push(`**錯誤**：${r.error}`, "");
    else if (typeof r.output === "string") lines.push(r.output, "");
    else lines.push(fence("json", JSON.stringify(r.output, null, 2)), "", `格式不對、重問了 ${r.stats?.retries ?? 0} 次`, "");
  }
  return lines.join("\n");
}
