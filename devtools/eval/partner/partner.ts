// 對話的另一方：評估對話型任務時，由 AI 扮演跟任務對話的人（本身也是一個對話型任務）
//   拿到任務的整份輸入和一段描述（他是誰、怎麼說話），不假設任務的輸入有哪些欄位
//   對話什麼時候停由評估的輪數上限決定，他自己不會結束對話
import { Type } from "typebox";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineDialogue, type Registered, type DialogueTask } from "../../../runtime/define.ts";

const task = defineDialogue({
  input: Type.Object({
    input: Type.String({ description: "受測任務收到的輸入（JSON）" }),
    partner: Type.String({ description: "扮演的人：他是誰、怎麼說話" }),
  }),
  example: { input: "{}", partner: "一般使用者" },
  state: () => ({}),
  promptInput: input => input,
  progress: () => ({}),
});

export const partner: Registered<DialogueTask<typeof task.input, {}, {}>> = {
  ...task,
  name: "eval-partner",
  dir: dirname(fileURLToPath(import.meta.url)),
};
