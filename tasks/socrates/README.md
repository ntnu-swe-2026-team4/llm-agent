# 蘇格拉底對話（socrates）

和學生一對一討論一道題目的對話任務：先問立場和理由，再挑戰這些理由，讓學生自己發現理由在哪裡遇到困難。寫在 [llm-framework](../../README.md) 上，後端用 `llm.socrates()` 呼叫。

- 每一輪由程式依學生講到哪決定「狀態」，不同狀態放入不同的 prompt 片段。
- AI 用工具回報學生這句話做了什麼（立場、理由、想走、痛苦……），程式照回報決定下一輪的狀態。
- AI 不會自己關掉對話。要不要結束由後端和老師決定，見第 4 章。

---

## 1. 試跑

在 `llm-framework/` 這一層執行。

```bash
bun test tasks/socrates      # 只測這個任務，不呼叫模型
```

```
 23 pass
 0 fail
```

```bash
bun llm render socrates      # 看第一輪送給 AI 的 prompt，不呼叫模型
bun llm try socrates         # 在終端機對話，要 key
bun llm ui                   # 開網頁：試跑時每一輪都看得到送給 AI 的內容和目前狀態；試跑要 key
bun llm eval socrates        # 跑 evals.json 的 10 種學生，評審 AI 打分，要 key
```

---

## 2. 輸入

| 欄位 | 必填 | 說明 |
|---|---|---|
| `title` | 要 | 題目名稱 |
| `statement` | 要 | 題目情境，學生在畫面上看得到 |
| `conflict` | 不用 | 挑戰方式：`auto`（預設，依對話情況切換）、`oppose`、`reductio`、`escalate` |
| `maxRounds` | 不用 | 輪數上限，最小 3。到倒數第二輪開始收尾。不設就沒有上限 |

沒有語言欄位：語言跟著學生說的話走，見第 6 章。AI 先開口，開場時 `history` 傳空陣列。

---

## 3. 狀態

| 狀態 | 中文 | 什麼時候進入 | 這一輪 AI 做什麼 |
|---|---|---|---|
| `ask-stance` | 問立場 | 還沒有立場。最多問 2 輪 | 交代事實，問他怎麼看 |
| `ask-reason` | 問理由 | 有立場、還沒有理由。最多問 2 輪 | 問他這樣選主要是因為什麼 |
| `oppose` | 對立辯護 | 預設的挑戰 | 提出另一邊最有力的理由 |
| `reductio` | 歸謬 | 他的理由是一條普遍原則 | 用他的原則推到他可能不接受的情況 |
| `escalate` | 加速 | 被挑戰後堅持 2 次以上 | 保留他的原則，把代價推高一步 |
| `engage` | 拉回 | 他這一句想脫離討論 | 不放他走，讓他願意再回答一句 |
| `listen` | 聆聽 | 拉回後的下一輪 | 接住他的回答，請他多說一點，不挑戰 |
| `close` | 收尾 | AI 判斷可以收，而且他至少回應過 3 次挑戰；或快到 `maxRounds` | 用他的話整理立場和理由 |
| `end` | 結束 | 收尾的下一輪 | 接住他對整理的回應，道謝 |
| `done` | 已結束 | 結束之後他又說話 | 簡短回應 |
| `care` | 關心 | 他在說自己真實的痛苦或想傷害自己 | 停止討論題目，先關心他 |

決定狀態的順序在 `task.ts` 的 `nextStage()`，由上往下，第一個符合的就是這一輪的狀態：關心 → 已結束 → 結束 → 輪數上限 → 拉回 → 聆聽 → 問立場 → 問理由 → 收尾 → 挑戰。

挑戰的三種方式不會連續用同一種。他想走之後的 3 輪內不用「加速」。

---

## 4. 怎麼結束

**AI 只提出「可以收尾」，不會自己關掉對話。**

- 每一輪 AI 用 `assess` 判斷能不能收。三件事都成立才算可以：他說得出判斷、理由和理由的困難；主要理由都被挑戰過；他這一句沒有新問題，也不是還在思考。
- 走到 `end` 或 `done` 時，`progress.ended` 是 `true`。後端看這個欄位，不用看 AI 說了什麼。
- 收尾之後他又提問或還在想：AI 判斷不能收，取消收尾、回到討論，`progress.ended` 變回 `false`。
- 說不想做、想走、老師說可以走，都不會進入收尾，只會進入 `engage`。

要在什麼時候真的結束（看 `ended`、老師提前結束、`maxRounds`），由後端決定。

---

## 5. 給後端的進度（`progress`）

每一輪從 `await reply.result` 拿到。呼叫方式見 [BACKEND.md](../../BACKEND.md)。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `stage` | 字串 | 這一輪的狀態（第 3 章） |
| `language` | 字串 | 目前回覆的語言 |
| `rounds` | 數字 | 第幾輪 |
| `stance` | 字串或 `null` | 學生目前的立場（原話） |
| `reasons` | 數字 | 說過幾個理由 |
| `challenges` | 數字 | AI 挑戰過幾次 |
| `answered` | 數字 | 學生回應了幾次挑戰 |
| `shifted` | 是非 | 立場有沒有改變過 |
| `readyNote` | 字串 | AI 判斷能不能收尾的理由 |
| `closing` | 是非 | 在 `close`、`end` 或 `done` |
| `ended` | 是非 | 在 `end` 或 `done` |
| `care` | 是非 | 在 `care`，學生可能需要老師注意 |
| `lookups` | 陣列 | 查過的名詞：`{ round, term, status }` |
| `disengaged` | 數字 | 學生想走幾次 |

回覆裡沒有 `[neutral]` 這類情緒標記。

---

## 6. 工具（AI 回報用）

| 工具 | AI 什麼時候呼叫 | 做什麼 |
|---|---|---|
| `note` | 學生說了立場、理由、想走、痛苦等 | 記到狀態，下一次決定狀態時用；`kind` 的定義寫在 `task.ts` 工具的 `description` |
| `assess` | 每一輪 | 記下能不能收尾和理由 |
| `set_language` | 學生整句的句型換成另一種語言 | 記下語言，之後都用它回覆；只夾幾個外語單字、只有幾個字時不換 |
| `lookup` | 學生問到跟題目有關、他不懂的名詞 | 查名詞，見第 7 章 |

---

## 7. 查名詞（接查詢服務）

框架裡先用測試資料，正式環境由查詢服務接上。查詢服務做好後，呼叫一次 `setLookup`（程式啟動時）：

```ts
import { setLookup } from "../../../../llm-framework/dist/worker.ts";   // 一般環境從 index.ts 引入

setLookup(async term => {
  // 呼叫查詢服務，回傳 LookupResult
  return { term, status: "not_found", summary: "", sources: [], error: null };
});
```

`LookupResult` 的格式照 PR #47：

| 欄位 | 說明 |
|---|---|
| `term` | 查的名詞 |
| `status` | `ok`、`insufficient`、`not_found`、`invalid`、`search_error`、`llm_error` |
| `summary` | 解釋，句尾以 `[n]` 標註來源；沒有時是空字串 |
| `sources` | `{ title, url, domain }[]` |
| `error` | `{ title, reason, hint? }` 或 `null` |

**本機試查名詞（選用）**：建一個 JSON 檔，名詞對應到一筆 `LookupResult`，`.env` 加 `LOOKUP_FIXTURE=檔案路徑`。沒設或查不到都算 `not_found`。

```json
{
  "效益主義": {
    "term": "效益主義",
    "status": "ok",
    "summary": "一種倫理學理論，主張行為的對錯取決於它能不能為最多人帶來最大的幸福。[1]",
    "sources": [{ "title": "效益主義", "url": "https://zh.wikipedia.org/wiki/效益主義", "domain": "zh.wikipedia.org" }],
    "error": null
  }
}
```

---

## 8. 要改什麼時改哪裡

| 想改 | 改哪裡 |
|---|---|
| 每一輪都適用的規則（語氣、語言、學生要走） | `prompts/main.prompt` |
| 某個狀態要做的事 | `prompts/_stage-<狀態>.prompt` |
| 查名詞的規則 | `prompts/_lookup.prompt` |
| 什麼時候進哪個狀態、收尾前至少回應幾次挑戰 | `task.ts` 的 `nextStage()` 和檔案開頭的常數 |
| AI 怎麼判斷學生這句話 | `task.ts` 裡工具的 `description` |
| 評估用的學生和條件 | `evals.json`，程式判斷在 `eval.ts` |

改完跑 `bun run check`，要 `0 fail`。

---

## 給開發者

```text
tasks/socrates/
├─ task.ts          # 核心：輸入、狀態、決策樹 nextStage()、工具、進度
├─ lookup.ts        # 查名詞的接口：LookupResult、setLookup、測試資料、交回給 AI 的文字
├─ task.test.ts     # 決策樹、prompt、工具、語言、查名詞的測試，不呼叫模型
├─ evals.json       # 評估：10 種學生和條件
├─ eval.ts          # 評估的程式判斷（沒有情緒標記、有挑戰學生、有收尾……）
└─ prompts/
   ├─ main.prompt            # 每一輪都有的規則，依狀態放入下面的片段
   ├─ _stage-<狀態>.prompt   # 每個狀態一份：目的、做法、學生的反應怎麼接、限制
   └─ _lookup.prompt         # 查名詞的規則
```
