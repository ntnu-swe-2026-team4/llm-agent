// socratic-dialogue 自己的測試（共通檢查由 tests/extensions.test.ts 自動跑）
import { describe, expect, test } from "bun:test";
import { render, tasks } from "../../devtools/testing.ts";
import { nextStage } from "./task.ts";

const task = tasks["socratic-dialogue"];
const none = { claim: false, reason: false, evidence: false, counter: false };

describe("階段判斷", () => {
  test("沒立場 → 問立場；有立場 → 問理由；有理由 → 反例；回應過反例 → 確認", () => {
    expect(nextStage(none, 1)).toBe("ask-stance");
    expect(nextStage({ ...none, claim: true }, 2)).toBe("ask-reason");
    expect(nextStage({ ...none, claim: true, reason: true }, 3)).toBe("challenge");
    expect(nextStage({ ...none, claim: true, reason: true, counter: true }, 4)).toBe("confirm");
  });

  test("快到輪數上限，一律確認（story #17）", () => {
    expect(nextStage(none, 19, 20)).toBe("confirm");
  });
});

describe("每輪的 prompt 跟著階段換", () => {
  test("第一輪：問立場", async () => {
    const r = await render(task, task.example);
    expect(r.system).toContain("問他在這個情境下會怎麼做");
  });

  test("記錄到立場和理由之後：丟反例", async () => {
    const state = task.state();
    state.coverage.claim = true;
    state.coverage.reason = true;
    const r = await render(task, task.example, { state, round: 3 });
    expect(r.system).toContain("如果換成這樣呢？");
  });
});

test("record_progress 會更新進度", () => {
  const state = task.state();
  const [record] = task.tools!(t => t);
  record!.run({ kind: "claim", quote: "我會拉" }, state);
  expect(task.progress(state, 1).coverage.claim).toBe(true);
});
