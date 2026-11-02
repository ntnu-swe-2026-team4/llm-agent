// debate-judge 自己的測試（共通檢查由 tests/extensions.test.ts 自動跑）
import { expect, test } from "bun:test";
import { render, tasks } from "../../devtools/testing.ts";

const task = tasks["debate-judge"];

test("環節和發言都會出現在 prompt 裡", async () => {
  const r = await render(task, task.example);
  expect(r.user).toContain("rebuttal");
  expect(r.user).toContain(task.example.speech);
});

test("立場盲：輸入帶立場會被擋下", async () => {
  await expect(render(task, { ...task.example, stance: "pro" })).rejects.toThrow("不能有 stance");
});
