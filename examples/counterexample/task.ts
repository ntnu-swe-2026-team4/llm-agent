// 階段 2 反例：針對組內的一條論點，公開丟出全強度的反例（Spec story #31 #32）
import { defineOneShot, Type } from "../../runtime/index.ts";

export default defineOneShot({
  input: Type.Object({
    question: Type.String({ description: "討論的題目" }),
    // 前端 GroupArgument 的 id、kind、text
    arguments: Type.Array(Type.Object({
      id: Type.String(),
      kind: Type.Enum(["claim", "reason", "evidence"]),
      text: Type.String(),
    }), { description: "該組目前的論點" }),
    references: Type.Optional(Type.Array(Type.String(), { description: "老師在題目附的參考反例" })),
  }),

  // 對應前端 GroupMessage（kind = ai_counterexample）；id、groupId、at 由後端補
  output: Type.Object({
    targetArgumentId: Type.String({ description: "要挑戰的論點 id" }),
    text: Type.String({ minLength: 20, maxLength: 200 }),
  }),

  example: {
    question: "電車難題：拉桿讓電車轉向，犧牲一人救五人，你會拉嗎？",
    arguments: [
      { id: "a1", kind: "claim", text: "應該拉桿" },
      { id: "a2", kind: "reason", text: "五條命比一條命多，數量多的就該優先" },
    ],
    references: ["器官移植：殺一個健康的人救五個病人"],
  },

  exampleOutput: {
    targetArgumentId: "a2",
    text: "如果救五個人的方法，是親手把一個人推下橋擋住電車，你們還會這樣做嗎？",
  },
});
