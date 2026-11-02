// 階段 1 個人調查：蘇格拉底式追問
// 階段：問立場 → 問理由 → 丟反例 → 確認；AI 用 record_progress 回報學生講了什麼，框架依此換下一輪的任務
import { defineDialogue, Type } from "../../runtime/index.ts";

export type Stage = "ask-stance" | "ask-reason" | "challenge" | "confirm";
type Kind = "claim" | "reason" | "evidence" | "counter";

export const MAX_ROUNDS = 20;

/** 階段判斷：快到輪數上限一律確認；否則看學生講到哪 */
export function nextStage(coverage: Record<Kind, boolean>, round: number, maxRounds = MAX_ROUNDS): Stage {
  if (round >= maxRounds - 1) return "confirm";
  if (!coverage.claim) return "ask-stance";
  if (!coverage.reason) return "ask-reason";
  if (!coverage.counter) return "challenge";
  return "confirm";
}

export default defineDialogue({
  input: Type.Object({
    question: Type.String({ description: "題目情境" }),
    axes: Type.Array(Type.Object({ left: Type.String(), right: Type.String() }), { description: "價值軸" }),
  }),

  example: {
    question: "電車難題：一台失控電車即將撞上五個人，你可以拉桿讓它轉向，但另一條軌道上有一個人。你會拉嗎？",
    axes: [{ left: "看結果", right: "看原則" }],
  },

  // AI 先開口：開對話時就提出第一個問題
  opener: "ai",

  state: () => ({
    stage: "ask-stance" as Stage,
    coverage: { claim: false, reason: false, evidence: false, counter: false } as Record<Kind, boolean>,
    records: [] as { round: number; kind: Kind; quote: string }[],
    round: 0,
  }),

  // 每輪 AI 回覆前：決定階段，交給 main.prompt
  promptInput: (input, s, round) => {
    s.round = round;
    s.stage = nextStage(s.coverage, round);
    return { ...input, stage: s.stage, round, maxRounds: MAX_ROUNDS };
  },

  tools: tool => [
    tool({
      name: "record_progress",
      description: "學生清楚說出主張(claim)、理由(reason)、例子或證據(evidence)、或對反例的回應(counter)時呼叫。quote 填學生原話。",
      parameters: Type.Object({
        kind: Type.Enum(["claim", "reason", "evidence", "counter"]),
        quote: Type.String(),
      }),
      run: ({ kind, quote }, s) => {
        s.coverage[kind] = true;
        s.records.push({ round: s.round, kind, quote });
        return "已記錄。";
      },
    }),
  ],

  // 對應前端 types.ts 的 Progress
  progress: (s, round) => ({
    rounds: round,
    maxRounds: MAX_ROUNDS,
    coverage: { ...s.coverage },
    readyToSummarize: nextStage(s.coverage, round) === "confirm",
  }),
});
