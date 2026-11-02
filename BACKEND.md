# `llm-framework/` 的介面（給後端）

LLM 組做好的 AI 功能，後端怎麼呼叫。LLM 組怎麼寫任務見 [README.md](README.md)。

- 只有一個入口：`llm-framework/index.ts`。每個任務是一個函式 `llm.任務名()`，輸入輸出都有 TypeScript 型別。
- 任務有兩種：**單次型**（給一份輸入，拿回一段文字或一份 JSON）、**對話型**（每一輪給對話紀錄，拿回串流的回覆）。
- 連線用的環境變數跟後端現在的一樣：`GLM_API_KEY`、`GLM_BASE_URL`、`GLM_MODEL`、`LLM_PROVIDER=mock`。
- LLM 組改 prompt、換模型，呼叫方式不變。

---

## 1. 接上

根目錄 `package.json` 的 `workspaces` 要有 `"llm-framework"`，`bun install` 才會裝 `llm-framework/` 用到的套件（`ajv`、`dotprompt`、`typebox`）。

```ts
import { llm, LLMError } from "../../../llm-framework/index.ts";   // 從 server/src/services/ 算起的路徑
```

`llm-framework/` 的型別會跟著 `bun run typecheck` 一起檢查，不用另外設定。

---

## 2. 有哪些任務

`llm-framework/index.ts` 的 `tasks` 清單就是全部。名稱 `position-draft` 的任務，函式是 `llm.positionDraft`。

每個任務的輸入、輸出寫在 `llm-framework/tasks/<任務>/task.ts`：

| `task.ts` 裡的 | 意思 |
|---|---|
| `input` | 呼叫時要傳的輸入 |
| `output` | 單次型：寫了就回這個格式的 JSON；沒寫就回一段文字 |
| `opener: "ai"` | 對話型：AI 先開口 |
| `progress` | 對話型：每一輪回傳的進度 |
| `example` / `exampleOutput` | 範例輸入 / 範例輸出 |

---

## 3. 單次型

回什麼看任務的 `task.ts` 有沒有寫 `output`：

| `task.ts` | 回什麼 | 型別 |
|---|---|---|
| 寫了 `output` | 一份照格式檢查過的 JSON | `output` 的格式 |
| 沒寫 `output` | 一段文字 | `string` |

只要最後的結果，直接 `await`：

```ts
const draft = await llm.positionDraft({ dialogue: "我會拉\n因為五個人比一個人多", lang: "zh" });
const text = await llm.termExplain({ term: "效益主義" });   // 沒寫 output 的任務：string
```

回的是文字時，也可以邊出邊送（串流）：

```ts
const answer = llm.termExplain({ term: "效益主義" });
for await (const piece of answer) {
  // 一段一段的文字
}
const full = await answer;   // 整段
```

- JSON 的任務要檢查完格式才給，所以 `for await` 拿不到東西，直接 `await`。
- JSON 的格式不對，`llm-framework/` 會自己重問，最多 2 次；還是不對才丟 `llm_no_result`。文字的任務模型什麼都沒回也丟 `llm_no_result`。

---

## 4. 對話型

`llm-framework/` 不記對話。每一輪傳入「到目前為止的對話紀錄」和「上一輪拿到的狀態」，拿回這一輪的回覆和新的狀態。

```ts
const reply = llm.socrates(
  { title: "電車難題", statement: "你會拉桿嗎？", lang: "zh" },   // 輸入：整段對話都一樣的東西
  { history, state },                                            // 對話紀錄、上一輪的狀態
);

for await (const piece of reply) {
  // 一段一段的文字（串流）
}
const { text, state: next, progress, round } = await reply.result;
```

| 參數 / 回傳 | 說明 |
|---|---|
| `history` | `{ role: "user" \| "assistant", text }[]`，最後一則是使用者剛說的話 |
| `state` | 上一輪回傳的 `state`；第一輪不給。是純 JSON，可以直接存進資料庫 |
| 開場 | 任務是 `opener: "ai"` 時，`history` 傳空陣列，回覆就是 AI 的開場白 |
| `text` | 這一輪的完整回覆 |
| `state` | 新的狀態，下一輪傳回來 |
| `progress` | 任務 `progress` 回傳的進度 |
| `round` | 第幾輪（AI 的第幾則回覆） |

不需要串流的話，直接 `await reply.result`。

---

## 5. 選項

兩種任務都可以多傳一個選項，全部可以不給：

```ts
await llm.positionDraft(input, { variant: "en", signal });
llm.socrates(input, { history, state }, { connection: { mock: true } });
```

| 選項 | 說明 |
|---|---|
| `variant` | prompt 版本（`main.<版本>.prompt`）；不給用 `main.prompt` |
| `signal` | `AbortSignal`，中途取消 |
| `connection` | 連線設定：`mock`、`apiKey`、`baseUrl`、`model`、`provider`。有給的蓋過環境變數 |

不給 `connection` 時，`llm-framework/` 讀環境變數和 `llm-framework/providers/models.json`：

| 環境變數 | 說明 |
|---|---|
| `LLM_PROVIDER` | 用 `models.json` 裡的哪個供應商；沒設就用第一個。`mock` = 不呼叫模型 |
| `GLM_API_KEY` | key。名稱是「供應商名稱轉大寫 + `_API_KEY`」 |
| `GLM_BASE_URL`、`GLM_MODEL` | 蓋過 `models.json` 的 `baseUrl`、`defaultModel` |

所以換供應商、換模型只要改 `.env` 和 `models.json`。`models.json` 的 `params`（現在是 `thinking: { type: "disabled" }`）會加進每一次請求。

`mock` 時不呼叫模型：單次型回任務的 `exampleOutput`，對話型回 `（mock 回覆：第 N 輪）`。

---

## 6. 錯誤

所有錯誤都是 `LLMError`，有 `code`、`status`（建議的 HTTP 狀態碼）、`message`（中文說明）：

| `code` | `status` | 什麼時候 |
|---|---|---|
| `llm_not_configured` | 503 | 沒有 key、沒有網址 |
| `llm_rate_limited` | 429 | 供應商限流，重試 4 次（等 3、6、12、24 秒）後還是限流 |
| `llm_unavailable` | 503 | 供應商錯誤、key 錯、額度用完（額度用完不重試）、連不上 |
| `llm_timeout` | 503 | 60 秒沒有收到任何東西 |
| `llm_invalid_input` | 422 | 輸入不符合任務的 `input`，或對話紀錄順序不對；不會呼叫模型。例：`position-draft 的輸入不合格：`<br>`- 缺少 dialogue` |
| `llm_no_result` | 503 | 單次型：重問 2 次，模型還是沒交出合格的 JSON；或回文字的任務模型什麼都沒回 |

- 前 4 個代碼跟 `server/src/messages.ts` 現有的訊息 key 同名。
- 重試只發生在還沒吐出任何文字之前。對話型吐出文字後才出錯，錯誤會從 `for await` 丟出來。

---

## 7. 型別

```ts
import type { Input, Output, State, Progress } from "../../../llm-framework/index.ts";

Input<"position-draft">    // 輸入
Output<"position-draft">   // 單次型的輸出（沒寫 output 的任務是 string）
State<"socrates">          // 對話型的狀態
Progress<"socrates">       // 對話型的進度
```

`LLMError`、`LLMErrorCode`、`HistoryMessage`、`Conversation`、`Reply`、`Answer`、`Turn`、`RunOptions`、`ConnectionSettings` 也從 `llm-framework/index.ts` 匯出。

---

## 8. LLM 組改了東西，後端會不會受影響

| LLM 組做了什麼 | 對後端 |
|---|---|
| 改 prompt、加 prompt 版本、換模型 | 沒有影響 |
| 新增任務 | 多一個 `llm.新任務()` 可以用 |
| 改任務的 `input`、`output`、`progress` | 型別跟著變，`bun run typecheck` 會指出用到的地方 |
