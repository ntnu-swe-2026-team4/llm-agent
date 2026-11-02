// 每個正式任務和範例都自動套用的檢查（不呼叫模型）
import { describe, expect, test } from "bun:test";
import { all as tasks } from "../index.ts";
import type { Registered } from "../runtime/define.ts";
import { renderTask } from "../runtime/prepare.ts";
import { variants } from "../runtime/prompt.ts";
import { check } from "../runtime/schema.ts";
import { loadChecks } from "../devtools/eval/checks.ts";
import { checkEvals, readEvals } from "../devtools/eval/evals-file.ts";

for (const task of Object.values(tasks) as Registered[]) {
  describe(task.name, () => {
    test("範例輸入符合 input", () => {
      expect(check(task.input, task.example)).toEqual([]);
    });

    if (task.kind === "oneshot" && task.output) {
      test("範例輸出符合 output", () => {
        expect(task.exampleOutput, "寫了 output 就要有 exampleOutput").toBeDefined();
        expect(check(task.output!, task.exampleOutput)).toEqual([]);
      });
    }

    test("每個 prompt 版本都能用範例輸入渲染", async () => {
      for (const v of variants(task.dir)) {
        const r = await renderTask(task, task.example, { variant: v });
        expect(r.system.length, `版本 ${v} 的 system prompt 是空的`).toBeGreaterThan(0);
      }
    });

    test("多給 input 沒宣告的欄位 → 擋下", async () => {
      await expect(renderTask(task, { ...(task.example as Record<string, unknown>), __extra: 1 })).rejects.toThrow("不能有 __extra");
    });

    // 改了 task.ts 的 input 之後，舊的評估情境可能對不上，在這裡抓出來
    test("評估的情境和標準（evals.json）合格", async () => {
      expect(checkEvals(task, readEvals(task), Object.keys(await loadChecks(task)))).toEqual([]);
    });

    test("少給必要欄位 → 擋下", async () => {
      for (const key of (task.input.required ?? []) as string[]) {
        const { [key]: _, ...rest } = task.example as Record<string, unknown>;
        await expect(renderTask(task, rest), `少了 ${key} 沒被擋`).rejects.toThrow(`缺少 ${key}`);
      }
    });
  });
}
