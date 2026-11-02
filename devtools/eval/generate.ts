// 讓 AI 依任務的輸入格式產生測試資料（網頁「比較版本」的「讓 AI 想」）
//   AI 只看任務自己宣告的東西：類型、輸入格式、main.prompt 的原文（不看範例輸入）
//   格式不合的丟掉；產生的名稱不會跟已經有的重複
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Registered } from "../../runtime/define.ts";
import { LLMError } from "../../runtime/errors.ts";
import { check, strict } from "../../runtime/schema.ts";
import type { EvalCase } from "./evals-file.ts";
import { askJudge } from "./judge.ts";
import { withRetry } from "./network.ts";

/** 從模型的回覆裡取出 JSON 陣列（可能包在 ```json … ``` 裡，前後可能有說明文字） */
function jsonArray(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(value)) return value;
    } catch {}
  }
  throw new LLMError("llm_no_result", "產生測試資料失敗：AI 回的不是 JSON 陣列，再按一次試試");
}

function promptFor(task: Registered, count: number, hint?: string, existing?: string[]) {
  const dialogue = task.kind === "dialogue";
  const item = dialogue
    ? `{"name": "這一筆的短標題（十個字以內）", "input": 照輸入格式的物件, "partner": "跟 AI 對話的人：他是誰、怎麼想、怎麼說話", "turns": 輪數上限（整數）}`
    : `{"name": "這一筆的短標題（十個字以內）", "input": 照輸入格式的物件}`;
  return [
    "你在替一個 AI 任務準備測試資料，用來比較這個任務不同版本的 prompt。",
    "",
    `【任務類型】${dialogue ? "對話型：給一份輸入開始一段對話，之後跟一個人多輪來回" : "單次型：每次給一份輸入，AI 交回一份結果"}`,
    "",
    "【這個任務的 prompt 原文（{{欄位}} 會換成輸入的值）】",
    readFileSync(join(task.dir, "prompts", "main.prompt"), "utf8"),
    "",
    "【輸入的格式（JSON Schema）】",
    JSON.stringify(strict(task.input), null, 2),
    "",
    "【要產生的】",
    `${count} 筆輸入，每一筆都要完全符合輸入的格式，彼此不一樣。`,
    ...(dialogue ? [
      "每一筆另外寫 partner：跟這個 AI 對話的人。另一個 AI 會照這段描述扮演他。每一筆的人要不一樣。",
      "每一筆另外寫 turns：這段對話的輪數上限（對方說一句、AI 回一句算一輪），到了就切斷。各筆的長短要不一樣，有短有長。",
    ] : []),
    ...(hint?.trim() ? [`方向：${hint.trim()}`] : []),
    ...(existing?.length ? [`已經有的（不要重複）：${existing.join("、")}`] : []),
    "",
    `只回一個 JSON 陣列，不要其他文字。每個元素：${item}`,
  ].join("\n");
}

export async function generateCases(
  task: Registered,
  options: {
    count: number;
    /** 想要什麼樣的測試資料（可不填） */
    hint?: string;
    /** 已經有的名稱 */
    existing?: string[];
    /** 換掉問 AI 的方式（測試用）；預設問評審模型 */
    ask?: (prompt: string) => Promise<string>;
  },
) {
  const count = Math.min(Math.max(Math.trunc(options.count) || 1, 1), 20);
  const dialogue = task.kind === "dialogue";
  const ask = options.ask ?? askJudge;
  const prompt = promptFor(task, count, options.hint, options.existing);
  const list = jsonArray(await withRetry("產生測試資料", () => ask(prompt), () => {}));

  const taken = new Set(options.existing ?? []);
  const cases: EvalCase[] = [];
  let dropped = 0;
  for (const raw of list) {
    const r = raw as { name?: unknown; input?: unknown; partner?: unknown; turns?: unknown };
    const badDialogue = dialogue && (typeof r?.partner !== "string" || !r.partner.trim() || !(Number.isInteger(r.turns) && (r.turns as number) >= 1));
    if (!r || check(task.input, r.input).length || badDialogue) {
      dropped++;
      continue;
    }
    // 名稱重複就加編號
    const base = typeof r.name === "string" && r.name.trim() ? r.name.trim() : `第 ${taken.size + 1} 筆`;
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
    taken.add(name);
    cases.push(dialogue ? { name, input: r.input, partner: String(r.partner).trim(), turns: r.turns as number } : { name, input: r.input });
  }
  return { cases, dropped };
}
