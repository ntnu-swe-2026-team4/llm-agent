// 執行層（後端會用到的部分）的測試，不呼叫真的模型：
//   單次型、對話型用假的模型函式（ChatFn）；呼叫模型的 HTTP 部分用本機的假 OpenAI 相容伺服器
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { connection } from "../runtime/config.ts";
import { defineDialogue, defineOneShot, type Task } from "../runtime/define.ts";
import { reply } from "../runtime/dialogue.ts";
import { LLMError } from "../runtime/errors.ts";
import { chat, type ChatFn, type ChatRequest, type ChatResult, type ToolCall } from "../runtime/model.ts";
import { answer, runOneShot } from "../runtime/oneshot.ts";

/** 放在暫存資料夾的任務，prompts/main.prompt 是 prompt */
function sample<T extends Task>(task: T, prompt: string) {
  const dir = mkdtempSync(join(tmpdir(), "task-"));
  mkdirSync(join(dir, "prompts"));
  writeFileSync(join(dir, "prompts", "main.prompt"), prompt);
  return { ...task, name: "sample", dir };
}

/** 假的模型：照順序回答 steps，並記下每次收到的請求 */
function scripted(steps: { text?: string; toolCalls?: ToolCall[] }[]) {
  const seen: ChatRequest[] = [];
  const fn: ChatFn = async function* (request): AsyncGenerator<string, ChatResult> {
    seen.push({ ...request, messages: [...request.messages] });
    const step = steps.shift() ?? {};
    const text = step.text ?? "";
    for (const part of text.match(/.{1,3}/gsu) ?? []) yield part; // 分段吐，像串流
    return { text, toolCalls: step.toolCalls ?? [] };
  };
  return { fn, seen };
}

const summary = () => sample(defineOneShot({
  input: Type.Object({ text: Type.String() }),
  output: Type.Object({ summary: Type.String() }),
  example: { text: "五個人比一個人多。" },
  exampleOutput: { summary: "救多數人。" },
}), `{{role "system"}}\n整理成一句話。\n\n{{role "user"}}\n{{text}}\n`);

/** 沒寫 output：回一段文字 */
const explain = () => sample(defineOneShot({
  input: Type.Object({ term: Type.String() }),
  example: { term: "效益主義" },
}), `{{role "system"}}\n用一句話解釋。\n\n{{role "user"}}\n{{term}}\n`);

const chatTask = (opener?: "ai" | "user") => sample(defineDialogue({
  input: Type.Object({ topic: Type.String() }),
  example: { topic: "電車難題" },
  opener,
  state: () => ({ notes: [] as string[] }),
  promptInput: (input, s, round) => ({ ...input, round, count: s.notes.length }),
  tools: tool => [tool({ name: "note", description: "記下學生的重點", parameters: Type.Object({ text: Type.String() }), run: ({ text }, s) => (s.notes.push(text), "已記下。") })],
  progress: (s, round) => ({ round, notes: s.notes.length }),
}), `{{role "system"}}\n只追問。第 {{round}} 輪，記了 {{count}} 個重點。\n\n{{role "user"}}\n題目：{{topic}}\n`);

// ─────────────────────────── 單次型 ───────────────────────────

test("單次型：system 最後附上輸出格式；格式錯就把錯誤告訴模型重問，第二次對了就回傳", async () => {
  const task = summary();
  const fake = scripted([{ text: `{"wrong": 1}` }, { text: "```json\n{\"summary\": \"救多數人\"}\n```" }]);
  const { output, stats } = await runOneShot(task, task.example, { chat: fake.fn });

  expect(output).toEqual({ summary: "救多數人" });
  expect(stats.retries).toBe(1);
  const first = fake.seen[0]!;
  expect(first.json).toBe(true);
  expect(first.messages[0]!.content).toContain("整理成一句話。");
  expect(first.messages[0]!.content).toContain("只輸出一個 JSON 物件");
  expect(first.messages[1]).toEqual({ role: "user", content: "五個人比一個人多。" });
  // 第二次：多了模型的錯誤回答和「格式不對」的說明
  expect(fake.seen[1]!.messages.at(-1)!.content).toContain("缺少 summary");
});

test("單次型：重問 2 次還是不對 → llm_no_result（503）", async () => {
  const task = summary();
  const fake = scripted([{ text: "不是 JSON" }, { text: "{}" }, { text: "{}" }]);
  const error = await runOneShot(task, task.example, { chat: fake.fn }).catch(e => e);
  expect(error).toBeInstanceOf(LLMError);
  expect(error).toMatchObject({ code: "llm_no_result", status: 503 });
});

test("單次型：輸入不合格 → llm_invalid_input（422），不呼叫模型", async () => {
  const task = summary();
  const fake = scripted([]);
  const error = await runOneShot(task, { text: 1 } as never, { chat: fake.fn }).catch(e => e);
  expect(error).toMatchObject({ code: "llm_invalid_input", status: 422 });
  expect(fake.seen.length).toBe(0);
});

test("單次型沒寫 output：回一段文字，一段段吐出；不附輸出格式、不要求 JSON", async () => {
  const task = explain();
  const fake = scripted([{ text: "追求最多人的最大幸福。" }]);
  const run = answer(task, task.example, { chat: fake.fn });
  const chunks: string[] = [];
  for await (const c of run) chunks.push(c);

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.join("")).toBe("追求最多人的最大幸福。");
  expect(await run).toBe("追求最多人的最大幸福。");
  expect(fake.seen[0]!.json).toBeUndefined();
  expect(fake.seen[0]!.messages[0]!.content).not.toContain("交回的格式");
});

test("單次型：await 直接拿到輸出；寫了 output 的拿到物件", async () => {
  const text = explain();
  const s: string = await answer(text, text.example, { chat: scripted([{ text: "一句話。" }]).fn });
  expect(s).toBe("一句話。");

  const json = summary();
  const o: { summary: string } = await answer(json, json.example, { chat: scripted([{ text: `{"summary": "救多數人"}` }]).fn });
  expect(o).toEqual({ summary: "救多數人" });
});

test("單次型沒寫 output：模型什麼都沒回 → llm_no_result", async () => {
  const task = explain();
  await expect(answer(task, task.example, { chat: scripted([{ text: "  " }]).fn }).result).rejects.toMatchObject({ code: "llm_no_result" });
});

// ─────────────────────────── 對話型 ───────────────────────────

test("對話型：messages = system（這一輪的）+ 背景資料 + 對話紀錄；回覆一段段吐出，result 有完整文字、狀態、進度", async () => {
  const task = chatTask();
  const fake = scripted([{ text: "為什麼你會拉？" }]);
  const history = [{ role: "user" as const, text: "我會拉" }];
  const turn = reply(task, task.example, { history }, { chat: fake.fn });

  const chunks: string[] = [];
  for await (const text of turn) chunks.push(text);
  const result = await turn.result;

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.join("")).toBe("為什麼你會拉？");
  expect(result).toMatchObject({ text: "為什麼你會拉？", round: 1, progress: { round: 1, notes: 0 } });
  expect(fake.seen[0]!.messages).toEqual([
    { role: "system", content: "只追問。第 1 輪，記了 0 個重點。" },
    { role: "user", content: "題目：電車難題" },
    { role: "user", content: "我會拉" },
  ]);
});

test("對話型：模型呼叫工具 → 框架執行、把結果交回去，模型接著回覆；新的狀態在 result 裡", async () => {
  const task = chatTask();
  const fake = scripted([
    { toolCalls: [{ id: "c1", name: "note", arguments: `{"text":"救多數人"}` }] },
    { text: "那如果是你的家人呢？" },
  ]);
  const result = await reply(task, task.example, { history: [{ role: "user", text: "救多數人" }] }, { chat: fake.fn }).result;

  expect(result.text).toBe("那如果是你的家人呢？");
  expect(result.state).toEqual({ notes: ["救多數人"] });
  expect(result.progress).toEqual({ round: 1, notes: 1 });
  expect(fake.seen[0]!.tools!.map(t => t.name)).toEqual(["note"]);
  expect(fake.seen[1]!.messages.slice(-2)).toEqual([
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "note", arguments: `{"text":"救多數人"}` } }] },
    { role: "tool", tool_call_id: "c1", content: "已記下。" },
  ]);
});

test("對話型：工具改了狀態，模型接著回覆時的 system 照新狀態重新渲染", async () => {
  const task = chatTask();
  const fake = scripted([
    { toolCalls: [{ id: "c1", name: "note", arguments: `{"text":"救多數人"}` }] },
    { text: "那如果是你的家人呢？" },
  ]);
  await reply(task, task.example, { history: [{ role: "user", text: "救多數人" }] }, { chat: fake.fn }).result;
  expect(fake.seen[0]!.messages[0]!.content).toBe("只追問。第 1 輪，記了 0 個重點。");
  expect(fake.seen[1]!.messages[0]!.content).toBe("只追問。第 1 輪，記了 1 個重點。");
});

test("對話型：promptInput 拿得到到目前為止的對話紀錄", async () => {
  const seen: unknown[] = [];
  const task = sample(defineDialogue({
    input: Type.Object({ topic: Type.String() }),
    example: { topic: "電車難題" },
    state: () => ({}),
    promptInput: (input, _s, round, history) => (seen.push(history), { ...input, round, last: history.at(-1)?.text ?? "" }),
    progress: () => ({}),
  }), `{{role "system"}}\n學生剛說：{{last}}\n`);
  const fake = scripted([{ text: "為什麼？" }]);
  await reply(task, task.example, { history: [{ role: "user", text: "I'd pull it" }] }, { chat: fake.fn }).result;
  expect(seen[0]).toEqual([{ role: "user", text: "I'd pull it" }]);
  expect(fake.seen[0]!.messages[0]!.content).toBe("學生剛說：I'd pull it");
});

test("對話型：工具可以是非同步（例如要連網查詢），結果等完才交回模型", async () => {
  const task = sample(defineDialogue({
    input: Type.Object({ topic: Type.String() }),
    example: { topic: "電車難題" },
    state: () => ({ looked: [] as string[] }),
    promptInput: (input, _s, round) => ({ ...input, round }),
    tools: tool => [tool({
      name: "lookup",
      description: "查名詞",
      parameters: Type.Object({ term: Type.String() }),
      run: async ({ term }, s) => {
        await new Promise(r => setTimeout(r, 5));
        s.looked.push(term);
        return `${term}：查到了`;
      },
    })],
    progress: s => ({ looked: s.looked.length }),
  }), `{{role "system"}}\n只追問。\n`);
  const fake = scripted([
    { toolCalls: [{ id: "c1", name: "lookup", arguments: `{"term":"效益主義"}` }] },
    { text: "查到了，那你怎麼看？" },
  ]);
  const result = await reply(task, task.example, { history: [{ role: "user", text: "效益主義是什麼" }] }, { chat: fake.fn }).result;
  expect(result.state).toEqual({ looked: ["效益主義"] });
  expect(fake.seen[1]!.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "效益主義：查到了" });
});

test("對話型：模型寫了回覆又呼叫工具 → 工具照樣執行，不再請它接著寫", async () => {
  const task = chatTask();
  const fake = scripted([
    { text: "那如果是你的家人呢？", toolCalls: [{ id: "c1", name: "note", arguments: `{"text":"救多數人"}` }] },
    { text: "這段不該出現" },
  ]);
  const result = await reply(task, task.example, { history: [{ role: "user", text: "救多數人" }] }, { chat: fake.fn }).result;
  expect(result.text).toBe("那如果是你的家人呢？");
  expect(result.state).toEqual({ notes: ["救多數人"] });
  expect(fake.seen.length).toBe(1);
});

test("對話型：模型只呼叫工具、接著回了空白 → 不給工具，再請它回覆一次", async () => {
  const task = chatTask();
  const fake = scripted([
    { toolCalls: [{ id: "c1", name: "note", arguments: `{"text":"好難"}` }] },
    { text: "  " },
    { text: "哪一部分最難？" },
  ]);
  const result = await reply(task, task.example, { history: [{ role: "user", text: "好難" }] }, { chat: fake.fn }).result;
  expect(result.text.trim()).toBe("哪一部分最難？");
  expect(fake.seen.length).toBe(3);
  expect(fake.seen[2]!.tools).toBeUndefined();
});

test("對話型：第幾輪看對話紀錄；上一輪的狀態傳回來，這一輪的 system 會跟著換", async () => {
  const task = chatTask();
  const fake = scripted([{ text: "好" }]);
  const history = [
    { role: "user" as const, text: "我會拉" },
    { role: "assistant" as const, text: "為什麼？" },
    { role: "user" as const, text: "人多" },
  ];
  const result = await reply(task, task.example, { history, state: { notes: ["人多"] } }, { chat: fake.fn }).result;
  expect(result.round).toBe(2);
  expect(fake.seen[0]!.messages[0]).toEqual({ role: "system", content: "只追問。第 2 輪，記了 1 個重點。" });
  expect(fake.seen[0]!.messages.length).toBe(5);
});

test("對話型 opener: \"ai\"：對話紀錄是空的就是開場，背景資料是第一則訊息，算第 1 輪", async () => {
  const task = chatTask("ai");
  const fake = scripted([{ text: "你會拉桿嗎？" }]);
  const result = await reply(task, task.example, {}, { chat: fake.fn }).result;
  expect(result).toMatchObject({ text: "你會拉桿嗎？", round: 1 });
  expect(fake.seen[0]!.messages).toEqual([
    { role: "system", content: "只追問。第 1 輪，記了 0 個重點。" },
    { role: "user", content: "題目：電車難題" },
  ]);
});

test("對話型：對話紀錄的順序不對 → llm_invalid_input（422）", async () => {
  const fake = scripted([]);
  // 使用者先說的任務，紀錄不能是空的
  await expect(reply(chatTask(), { topic: "x" }, {}, { chat: fake.fn }).result).rejects.toMatchObject({ code: "llm_invalid_input", status: 422 });
  // 最後一則要是使用者的話
  const history = [{ role: "user" as const, text: "a" }, { role: "assistant" as const, text: "b" }];
  await expect(reply(chatTask(), { topic: "x" }, { history }, { chat: fake.fn }).result).rejects.toMatchObject({ code: "llm_invalid_input" });
  expect(fake.seen.length).toBe(0);
});

test("LLM_PROVIDER=mock：不呼叫模型，單次型回範例輸出，對話型回固定的假回覆", async () => {
  process.env.LLM_PROVIDER = "mock";
  try {
    const task = summary();
    expect((await runOneShot(task, task.example)).output).toEqual({ summary: "救多數人。" });
    const text = explain();
    expect(await answer(text, text.example)).toBe("（mock 回覆）");
    const result = await reply(chatTask(), { topic: "x" }, { history: [{ role: "user", text: "嗨" }] }).result;
    expect(result.text).toBe("（mock 回覆：第 1 輪）");
  } finally {
    delete process.env.LLM_PROVIDER;
  }
});

test("呼叫端傳 connection: { mock: true }：沒有 LLM_PROVIDER 也不呼叫模型", async () => {
  const task = summary();
  expect((await runOneShot(task, task.example, { connection: { mock: true } })).output).toEqual({ summary: "救多數人。" });
  const result = await reply(chatTask(), { topic: "x" }, { history: [{ role: "user", text: "嗨" }] }, { connection: { mock: true } }).result;
  expect(result.text).toBe("（mock 回覆：第 1 輪）");
});

// ─────────────────────────── 呼叫模型（HTTP） ───────────────────────────

/** 假的 OpenAI 相容伺服器：依 x-scenario 決定怎麼回 */
let server: ReturnType<typeof Bun.serve>;
const received: Record<string, unknown>[] = [];
let scenario = "";

const sse = (...events: unknown[]) =>
  new Response(events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push((await req.json()) as Record<string, unknown>);
      if (scenario === "text") {
        return sse(
          { choices: [{ delta: { reasoning_content: "（思考過程，不該出現）" } }] },
          { choices: [{ delta: { content: "你好" } }] },
          { choices: [{ delta: { content: "，同學" } }] },
          "[DONE]",
        );
      }
      if (scenario === "tool") {
        return sse(
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "note", arguments: `{"te` } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `xt":"a"}` } }] } }] },
          "[DONE]",
        );
      }
      if (scenario === "quota") return Response.json({ error: { code: "1113", message: "餘額不足" } }, { status: 429 });
      if (scenario === "unauthorized") return Response.json({ error: { message: "token expired" } }, { status: 401 });
      return new Response("?", { status: 500 });
    },
  });
  process.env.GLM_BASE_URL = `http://127.0.0.1:${server.port}`;
  process.env.GLM_API_KEY = "test-key";
});

afterAll(() => {
  server.stop(true);
  delete process.env.GLM_BASE_URL;
  delete process.env.GLM_API_KEY;
});

async function collect(request: ChatRequest) {
  const chunks: string[] = [];
  const stream = chat(request);
  for (;;) {
    const next = await stream.next();
    if (next.done) return { chunks, result: next.value };
    chunks.push(next.value);
  }
}

test("HTTP：串流文字一段段吐出，思考過程略過；models.json 的 params、格式要求都送出去", async () => {
  scenario = "text";
  received.length = 0;
  const { chunks, result } = await collect({ messages: [{ role: "user", content: "嗨" }], json: true, temperature: 0.2 });
  expect(chunks).toEqual(["你好", "，同學"]);
  expect(result).toEqual({ text: "你好，同學", toolCalls: [] });
  expect(received[0]).toMatchObject({
    stream: true,
    temperature: 0.2,
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: "嗨" }],
  });
});

test("HTTP：呼叫端傳的 key、網址、模型蓋過環境變數", async () => {
  scenario = "text";
  received.length = 0;
  let auth = "";
  const other = Bun.serve({ port: 0, fetch: req => ((auth = req.headers.get("authorization") ?? ""), server.fetch(req)) });
  try {
    const connection = { baseUrl: `http://127.0.0.1:${other.port}`, apiKey: "backend-key", model: "glm-4.7" };
    const { result } = await collect({ messages: [{ role: "user", content: "嗨" }], connection });
    expect(result.text).toBe("你好，同學");
    expect(auth).toBe("Bearer backend-key");
    expect(received[0]).toMatchObject({ model: "glm-4.7" });
  } finally {
    other.stop(true);
  }
});

test("HTTP：分段送來的工具呼叫會接起來", async () => {
  scenario = "tool";
  const { result } = await collect({ messages: [{ role: "user", content: "嗨" }], tools: [{ name: "note", description: "", parameters: {} }] });
  expect(result.toolCalls).toEqual([{ id: "t1", name: "note", arguments: `{"text":"a"}` }]);
});

test("HTTP：錯誤分類跟後端原本一樣——額度用完 503（不重試）、key 錯 503、沒設 key 503 llm_not_configured", async () => {
  scenario = "quota";
  received.length = 0;
  await expect(collect({ messages: [] })).rejects.toMatchObject({ code: "llm_unavailable", status: 503 });
  expect(received.length).toBe(1); // 額度用完重試也沒用，只送一次

  scenario = "unauthorized";
  await expect(collect({ messages: [] })).rejects.toMatchObject({ code: "llm_unavailable", status: 503 });

  const key = process.env.GLM_API_KEY;
  delete process.env.GLM_API_KEY;
  await expect(collect({ messages: [] })).rejects.toMatchObject({ code: "llm_not_configured", status: 503 });
  process.env.GLM_API_KEY = key;
});

test("connection 的 params 取代 models.json 的；LLM_PROVIDER 不是供應商名稱時，傳了網址、key、模型一樣能連", () => {
  process.env.LLM_PROVIDER = "dev";
  try {
    const c = connection({ baseUrl: "http://x/v1/", apiKey: "k", model: "m", params: { thinking: { type: "enabled" } } });
    expect(c).toMatchObject({ baseUrl: "http://x/v1", apiKey: "k", model: "m", params: { thinking: { type: "enabled" } }, mock: false });
  } finally {
    delete process.env.LLM_PROVIDER;
  }
  expect(connection({ provider: "glm" }).params).toEqual({ thinking: { type: "disabled" } });
});
