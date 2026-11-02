// counterexample 自己的測試（共通檢查由 tests/extensions.test.ts 自動跑）
import { expect, test } from "bun:test";
import { render, tasks } from "../../devtools/testing.ts";

const task = tasks.counterexample;

test("每條論點都帶 id 給 AI，AI 才能指定要挑戰哪一條", async () => {
  const r = await render(task, task.example);
  expect(r.user).toContain("[a1]（claim）應該拉桿");
  expect(r.user).toContain("[a2]（reason）");
});

test("有參考反例才顯示那一段", async () => {
  const withRefs = await render(task, task.example);
  expect(withRefs.system).toContain("器官移植");
  const { references, ...noRefs } = task.example;
  expect((await render(task, noRefs)).system).not.toContain("參考反例");
});
