// 評估：evals.json 的檢查、產生測試資料、轉成 promptfoo 設定（不呼叫模型）
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { defineDialogue, defineOneShot, type Task } from "../runtime/define.ts";
import { checkEvals, readEvals, type EvalFile } from "../devtools/eval/evals-file.ts";
import { generateCases } from "../devtools/eval/generate.ts";
import { toPromptfoo } from "../devtools/eval/promptfoo.ts";
import { isNetworkError, withRetry } from "../devtools/eval/network.ts";
import { LLMError } from "../runtime/errors.ts";

/** 放在暫存資料夾的任務，有 main 和 b 兩個版本 */
function sample<T extends Task>(task: T) {
  const dir = mkdtempSync(join(tmpdir(), "eval-"));
  mkdirSync(join(dir, "prompts"));
  writeFileSync(join(dir, "prompts", "main.prompt"), "{{role \"system\"}}\n把文字整理成一句話。\n\n{{role \"user\"}}\n{{text}}\n");
  writeFileSync(join(dir, "prompts", "main.b.prompt"), "{{text}}\n");
  return { ...task, name: "sample", dir };
}

const oneshot = () => sample(defineOneShot({
  input: Type.Object({ text: Type.String({ description: "要整理的文字" }) }),
  output: Type.Object({ summary: Type.String() }),
  example: { text: "範例文字不該出現在產生測試資料的 prompt 裡" },
  exampleOutput: { summary: "摘要" },
}));

const dialogue = () => sample(defineDialogue({
  input: Type.Object({ text: Type.String() }),
  example: { text: "範例" },
  state: () => ({}),
  promptInput: input => input,
  progress: () => ({}),
}));

test("沒有 evals.json 就是還沒有測試資料", () => {
  expect(readEvals(oneshot())).toEqual({ criteria: [], cases: [] });
});

test("檢查：名稱、輸入（必填、照格式）、程式判斷的名稱、對話型的另一方", () => {
  const data = {
    criteria: [{ type: "yesno", text: "" }, { type: "check", name: "不存在" }],
    cases: [
      { name: "a", input: { text: 1 } },
      { name: "a" },
      { name: " ", input: { text: "x" }, criteria: [{ type: "score", text: "x", threshold: 2 }] },
    ],
  } as unknown as EvalFile;
  expect(checkEvals(oneshot(), data, ["有的"])).toEqual([
    "共同標準第 1 條：標準沒有寫內容",
    "共同標準第 2 條：eval.ts 裡沒有叫「不存在」的程式判斷",
    "測試資料「a」 的輸入：text 應該是 string",
    "測試資料「a」：名稱重複",
    "測試資料「a」：沒有輸入",
    "第 3 筆測試資料：沒有名稱",
    "第 3 筆測試資料 的第 1 條標準：門檻要在 0 到 1 之間",
  ]);
  // 對話型：AI 扮演要寫描述和輪數上限（沒有預設值）；固定台詞至少一句；兩種只能選一個
  expect(checkEvals(dialogue(), { criteria: [], cases: [
    { name: "s", input: { text: "x" }, turns: 0 },
    { name: "t", input: { text: "x" }, partner: "某人" },
    { name: "u", input: { text: "x" }, script: [] },
    { name: "v", input: { text: "x" }, script: ["你好", " "] },
    { name: "w", input: { text: "x" }, script: ["你好"], partner: "某人" },
  ] }, [])).toEqual([
    "測試資料「s」：沒有寫對話的另一方",
    "測試資料「s」：輪數上限要是 1 以上的整數",
    "測試資料「t」：輪數上限要是 1 以上的整數",
    "測試資料「u」：固定台詞至少要一句，而且不能有空的",
    "測試資料「v」：固定台詞至少要一句，而且不能有空的",
    "測試資料「w」：「AI 扮演」和「固定台詞」只能選一個",
  ]);
  expect(checkEvals(dialogue(), { criteria: [], cases: [
    { name: "a", input: { text: "x" }, partner: "某人", turns: 3 },
    { name: "b", input: { text: "x" }, script: ["你好", "為什麼？"] },
  ] }, [])).toEqual([]);
  expect(checkEvals(oneshot(), { criteria: [{ type: "best", text: "哪個好" }], cases: [{ name: "a", input: { text: "x" } }] }, [])).toEqual([]);
});

test("產生測試資料：AI 只看任務宣告的東西；格式不合的丟掉；名稱不重複", async () => {
  let asked = "";
  const reply = JSON.stringify([
    { name: "短文", input: { text: "一段短文" } },
    { name: "短文", input: { text: "另一段" } },
    { name: "格式錯", input: { text: 3 } },
    { name: "多欄位", input: { text: "x", extra: 1 } },
  ]);
  const r = await generateCases(oneshot(), { count: 4, hint: "要有很長的文字", existing: ["短文"], ask: async p => ((asked = p), `好的：\n\`\`\`json\n${reply}\n\`\`\``) });

  expect(r.cases).toEqual([{ name: "短文 2", input: { text: "一段短文" } }, { name: "短文 3", input: { text: "另一段" } }]);
  expect(r.dropped).toBe(2);
  // 給 AI 看的：任務類型、prompt 原文、輸入格式、方向、已有的名稱；不給範例輸入
  expect(asked).toContain("單次型");
  expect(asked).toContain("把文字整理成一句話。");
  expect(asked).toContain("要整理的文字");
  expect(asked).toContain("方向：要有很長的文字");
  expect(asked).toContain("已經有的（不要重複）：短文");
  expect(asked).not.toContain("範例文字");
});

test("產生測試資料：對話型每筆要有另一方的描述和輪數上限（由 AI 各給不同的），缺了就丟掉", async () => {
  let asked = "";
  const reply = JSON.stringify([
    { name: "甲", input: { text: "x" }, partner: "急著要答案的人", turns: 3 },
    { name: "乙", input: { text: "y" }, partner: "慢慢想的人", turns: 9 },
    { name: "丙", input: { text: "z" }, turns: 4 },
    { name: "丁", input: { text: "w" }, partner: "沒給輪數的人" },
  ]);
  const r = await generateCases(dialogue(), { count: 4, ask: async p => ((asked = p), reply) });
  expect(r.cases).toEqual([
    { name: "甲", input: { text: "x" }, partner: "急著要答案的人", turns: 3 },
    { name: "乙", input: { text: "y" }, partner: "慢慢想的人", turns: 9 },
  ]);
  expect(r.dropped).toBe(2);
  expect(asked).toContain("turns");
  await expect(generateCases(dialogue(), { count: 1, ask: async () => "抱歉，我無法" })).rejects.toThrow("不是 JSON 陣列");
});

test("轉成 promptfoo：每筆一個 test，共同標準加這一筆自己的；只跑一個版本時拿掉「版本比較」", () => {
  const task = oneshot();
  writeFileSync(join(task.dir, "evals.json"), JSON.stringify({
    criteria: [{ type: "yesno", text: "有沒有通過？" }, { type: "best", text: "哪個好？" }],
    cases: [{ name: "甲", input: { text: "輸入甲" }, criteria: [{ type: "score", text: "分數", threshold: 0.8 }] }, { name: "乙", input: { text: "輸入乙" } }],
  }));

  const all = toPromptfoo(task);
  expect((all.prompts as { label: string }[]).map(p => p.label).sort()).toEqual(["b", "main"]);
  const tests = all.tests as { description: string; vars: { input: string }; assert: { type: string; threshold?: number }[] }[];
  expect(tests.map(t => t.description)).toEqual(["甲", "乙"]);
  expect(tests[0]!.assert.map(a => a.type)).toEqual(["llm-rubric", "select-best", "g-eval"]);
  expect(tests[0]!.assert[2]!.threshold).toBe(0.8);
  expect(JSON.parse(tests[1]!.vars.input)).toEqual({ text: "輸入乙" });

  const one = toPromptfoo(task, ["b"]);
  expect((one.prompts as { label: string }[]).map(p => p.label)).toEqual(["b"]);
  expect((one.tests as typeof tests)[0]!.assert.map(a => a.type)).toEqual(["llm-rubric", "g-eval"]);
});

test("轉成 promptfoo：對話型把另一方的描述和輪數上限、或固定台詞交給 provider", () => {
  const task = dialogue();
  writeFileSync(join(task.dir, "evals.json"), JSON.stringify({ criteria: [], cases: [
    { name: "甲", input: { text: "x" }, partner: "急著要答案的人", turns: 7 },
    { name: "乙", input: { text: "y" }, script: ["你好", "為什麼？"] },
  ] }));
  const tests = toPromptfoo(task).tests as { vars: Record<string, unknown> }[];
  expect(tests[0]!.vars).toEqual({ input: JSON.stringify({ text: "x" }), partner: "急著要答案的人", turns: 7 });
  expect(tests[1]!.vars).toEqual({ input: JSON.stringify({ text: "y" }), script: JSON.stringify(["你好", "為什麼？"]) });
});

test("網路問題：斷線、逾時、限流就整個步驟重來；額度用完、key 錯不重來", async () => {
  const net = Object.assign(new LLMError("llm_unavailable", "呼叫模型失敗：連線中斷"), { retryable: true });
  const quota = Object.assign(new LLMError("llm_unavailable", "呼叫模型失敗（額度用完）"), { retryable: false });
  expect(isNetworkError(net)).toBe(true);
  expect(isNetworkError(new LLMError("llm_timeout", "60 秒沒有回應"))).toBe(true);
  expect(isNetworkError(new LLMError("llm_rate_limited", "限流"))).toBe(true);
  expect(isNetworkError(quota)).toBe(false);
  expect(isNetworkError(new LLMError("llm_no_result", "格式不對"))).toBe(false);

  const lines: string[] = [];
  let calls = 0;
  const value = await withRetry("AI 回一輪", async () => {
    if (++calls < 3) throw net;
    return "好了";
  }, l => lines.push(l), [0, 0]);
  expect(value).toBe("好了");
  expect(lines.length).toBe(2);

  calls = 0;
  await expect(withRetry("評審", async () => { calls++; throw quota; }, () => {}, [0, 0])).rejects.toBe(quota);
  expect(calls).toBe(1);
});
