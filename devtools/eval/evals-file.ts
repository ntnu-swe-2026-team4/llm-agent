// 評估的內容：每個任務的 evals.json（在網頁的「比較版本」編輯；沒有這個檔 = 還沒有測試資料）
//   測試資料（cases）：單次型是一份 input；對話型多了對話的另一方（AI 扮演 partner + 輪數上限 turns，或固定台詞 script）
//   標準（criteria）：每一筆都要過的放最外層，只套用在某一筆的放在那一筆裡
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Registered } from "../../runtime/define.ts";
import { LLMError } from "../../runtime/errors.ts";
import { check } from "../../runtime/schema.ts";

export type Criterion =
  /** 是非題：評審 AI 判斷通過或不通過 */
  | { type: "yesno"; text: string }
  /** 評分：評審 AI 依標準打 0–1 分，低於 threshold（預設 0.6）不通過 */
  | { type: "score"; text: string; threshold?: number }
  /** 版本比較：評審 AI 從這次跑的版本裡選出最好的（只跑一個版本時略過） */
  | { type: "best"; text: string }
  /** 程式判斷：eval.ts 裡同名的函式 */
  | { type: "check"; name: string };

/** 一筆測試資料 */
export interface EvalCase {
  /** 用來在結果表上認出這一筆 */
  name: string;
  /** 交給任務的輸入，格式照 task.ts 的 input */
  input: unknown;
  /** 對話型（二選一）：對話另一方的描述（他是誰、怎麼說話），另一個 AI 照著扮演 */
  partner?: string;
  /** 對話型（二選一）：固定台詞，一則一則照順序送出，送完就結束 */
  script?: string[];
  /** 對話型、用 partner 時：輪數上限，到了就切斷（對方說一句、AI 回一句算一輪）。怎麼結束由任務自己設計 */
  turns?: number;
  /** 這一筆自己的標準（加在共同標準後面） */
  criteria?: Criterion[];
}

export interface EvalFile {
  /** 每一筆都要通過的標準 */
  criteria: Criterion[];
  cases: EvalCase[];
}

export const KIND: Record<Criterion["type"], string> = { yesno: "是非題", score: "評分", best: "版本比較", check: "程式判斷" };

export const evalsPath = (task: Registered) => join(task.dir, "evals.json");

export function readEvals(task: Registered): EvalFile {
  const f = evalsPath(task);
  if (!existsSync(f)) return { criteria: [], cases: [] };
  try {
    return JSON.parse(readFileSync(f, "utf8")) as EvalFile;
  } catch (e) {
    throw new LLMError("llm_invalid_input", `${task.name}/evals.json 不是合法的 JSON：${(e as Error).message}`);
  }
}

/** 檢查 evals.json 的內容；回傳錯誤清單，空陣列代表合格。checks = eval.ts 裡有的程式判斷名稱 */
export function checkEvals(task: Registered, data: unknown, checks: string[]): string[] {
  const errors: string[] = [];
  const d = data as Partial<EvalFile> | null;
  if (!d || !Array.isArray(d.criteria) || !Array.isArray(d.cases)) return ["格式應該是 { criteria: [...], cases: [...] }"];

  const criterion = (c: Criterion, where: string) => {
    if (!c || !(c.type in KIND)) return errors.push(`${where}：種類只能是 ${Object.keys(KIND).join("、")}`);
    if (c.type === "check") {
      if (!checks.includes(c.name)) errors.push(`${where}：eval.ts 裡沒有叫「${c.name ?? ""}」的程式判斷`);
      return;
    }
    if (typeof c.text !== "string" || !c.text.trim()) errors.push(`${where}：標準沒有寫內容`);
    if (c.type === "score" && c.threshold !== undefined && !(c.threshold >= 0 && c.threshold <= 1)) errors.push(`${where}：門檻要在 0 到 1 之間`);
  };
  d.criteria.forEach((c, i) => criterion(c, `共同標準第 ${i + 1} 條`));

  const names = new Set<string>();
  d.cases.forEach((c, i) => {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    const where = name ? `測試資料「${name}」` : `第 ${i + 1} 筆測試資料`;
    if (!name) errors.push(`${where}：沒有名稱`);
    else if (names.has(name)) errors.push(`${where}：名稱重複`);
    names.add(name);
    if (c.input === undefined) errors.push(`${where}：沒有輸入`);
    else errors.push(...check(task.input, c.input).map(e => `${where} 的輸入：${e}`));
    if (task.kind === "dialogue") {
      if (c.script !== undefined) {
        if (c.partner !== undefined) errors.push(`${where}：「AI 扮演」和「固定台詞」只能選一個`);
        if (!Array.isArray(c.script) || !c.script.length || c.script.some(s => typeof s !== "string" || !s.trim())) errors.push(`${where}：固定台詞至少要一句，而且不能有空的`);
      } else {
        if (typeof c.partner !== "string" || !c.partner.trim()) errors.push(`${where}：沒有寫對話的另一方`);
        if (!(Number.isInteger(c.turns) && c.turns! >= 1)) errors.push(`${where}：輪數上限要是 1 以上的整數`);
      }
    }
    (c.criteria ?? []).forEach((k, j) => criterion(k, `${where} 的第 ${j + 1} 條標準`));
  });
  return errors;
}

export function writeEvals(task: Registered, data: EvalFile, checks: string[]) {
  const errors = checkEvals(task, data, checks);
  if (errors.length) throw new LLMError("llm_invalid_input", `評估內容有問題：\n- ${errors.join("\n- ")}`);
  writeFileSync(evalsPath(task), JSON.stringify(data, null, 2) + "\n");
}
