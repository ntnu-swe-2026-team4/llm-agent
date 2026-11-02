// 評審 AI：評估打分、產生測試資料都用它
//   模型用環境變數 JUDGE_MODEL；沒設就跟受測的任務用同一個模型
import { connection, describe } from "../../runtime/config.ts";
import { complete, type ChatFn } from "../../runtime/model.ts";

export const judgeModel = () => process.env.JUDGE_MODEL?.trim() || undefined;

/** 給人看的「供應商/模型」：受測模型、評審模型 */
export const testedModelName = () => describe(connection());
export const judgeModelName = () => describe(connection({ model: judgeModel() }));

/** 問評審 AI 一段話，拿回整段文字。chatFn 可以換成假的（測試用） */
export const askJudge = (prompt: string, chatFn?: ChatFn) =>
  complete({ messages: [{ role: "user", content: prompt }], model: judgeModel() }, chatFn);
