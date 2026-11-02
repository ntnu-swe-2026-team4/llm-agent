// 階段 3 裁判：評一段辯論發言的論證品質（立場盲：輸入裡沒有立場）
import { defineOneShot, Type } from "../../runtime/index.ts";

const score = Type.Union([Type.Integer({ minimum: 0, maximum: 5 }), Type.Null()]);
const note = Type.Optional(Type.String({ maxLength: 60 }));

export default defineOneShot({
  input: Type.Object({
    phase: Type.Enum(["opening", "cross", "rebuttal", "closing"], { description: "辯論環節" }),
    speech: Type.String({ description: "這一段發言" }),
  }),

  // 對應前端 types.ts 的 Judgment（id、turnId 等由後端補）
  output: Type.Object({
    scores: Type.Object({ evidence: score, reasoning: score, rebuttal: score, clarity: score }),
    notes: Type.Object({ evidence: note, reasoning: note, rebuttal: note, clarity: note }),
    verifiability: Type.Enum(["sourced", "checkable", "unverified"]),
  }),

  example: {
    phase: "rebuttal",
    speech: "對方說人數多就該優先，但如果五個人是自願冒險、一個人是無辜路人，單看人數就忽略了責任歸屬。",
  },

  exampleOutput: {
    scores: { evidence: 3, reasoning: 4, rebuttal: 4, clarity: 5 },
    notes: { evidence: "「自願冒險」的例子可以更具體" },
    verifiability: "unverified",
  },
});
