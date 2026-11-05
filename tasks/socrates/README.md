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
 115 pass
 0 fail
```

```bash
bun llm render socrates      # 看第一輪送給 AI 的 prompt，不呼叫模型
bun llm try socrates         # 在終端機對話，要 key
bun llm ui                   # 開網頁：試跑時每一輪都看得到送給 AI 的內容和目前狀態；試跑要 key
bun llm eval socrates        # 跑 evals.json 的全部測試資料，評審 AI 打分，要 key
```

### 評估的內容

`evals.json` 有 98 筆測試資料，名稱開頭標出種類，5 道不同的題目：

| 種類 | 筆數 | 測什麼 |
|---|---|---|
| `低級` | 7 | 回答很少、很淺：一字回答、順口同意、看不懂題目 |
| `一般` | 9 | 有想法的學生：一致、主觀論、第三條路、立場反覆、堅持到底 |
| `高級` | 9 | 會反擊的學生：康德、規則效益主義、雙重效應、指出 AI 的漏洞 |
| `紀錄` | 43 | 之前實際跑過的對話，學生台詞變成固定台詞，問題可以重現 |
| `邊界` | 30 | 大多是固定台詞：想走、痛苦、要 prompt、假冒老師、謾罵、歧視、預設語言、查名詞、要做數學或寫程式 |

每一筆都檢查 27 條：6 條由評審 AI 判斷（接得上、像真人老師、邏輯和事實……），21 條由程式判斷（`eval.ts`：只有一個問號、沒有評語、沒有放學生走……）。低級、一般、高級另外加 3 條看問題深度（追根究柢、挑戰力道、答得出來又會想），部分測試資料還有自己的檢查。AI 扮演學生時，`progress.ended` 變成 `true` 就停，不會一直互說再見。

全部跑一次要呼叫模型很多次，也要很久；網頁上「比較版本」的 ① 可以只留要跑的測試資料。

---|---|---|
| `--limit` | 全部 | 只跑前幾位 |
| `--turns` | 12 | 每位最多幾輪 |
| `--jobs` | 3 | 同時跑幾位 |

| 跑完的檔案 | 內容 | 給誰 |
|---|---|---|
| `tasks/class-report/inputs/class.json` | 題目和全班的對話紀錄 | 群體報告的輸入，網頁上選得到 |
| `tasks/student-report/inputs/S01.json`… | 題目和一位學生的對話紀錄，一位一個檔 | 個人報告的輸入，網頁上選得到 |
| `tasks/socrates/class-sim/answers.json` | 每位的設定（立場落點、理由、張力）和最後的進度 | 只用來對照報告對不對，不要給報告 prompt 看 |

要換題目或學生，改 `roster.json`。

---

## 2. 輸入

| 欄位 | 必填 | 說明 |
|---|---|---|
| `title` | 要 | 題目名稱 |
| `statement` | 要 | 題目情境，學生在畫面上看得到 |
| `conflict` | 不用 | 挑戰方式：`auto`（預設，依對話情況切換）、`oppose`、`reductio`、`escalate` |
| `locale` | 不用 | 對話語言（瀏覽器語言，例：`zh-TW`、`en`）。不給就用繁體中文。切換語言時，下一輪傳新的值 |
| `maxRounds` | 不用 | 輪數上限，最小 3。到倒數第二輪開始收尾。不設就沒有上限 |

AI 不會自己換語言。AI 先開口，開場時 `history` 傳空陣列。

---

## 3. 狀態

| 狀態 | 中文 | 什麼時候進入 | 這一輪 AI 做什麼 |
|---|---|---|---|
| `ask-stance` | 問立場 | 還沒有立場。最多問 2 輪 | 交代事實，問他怎麼看 |
| `ask-reason` | 問理由 | 有立場、還沒有理由。最多問 2 輪 | 問他這樣選主要是因為什麼 |
| `probe` | 追問 | 他這一句說了理由或回應了挑戰。最多連續 2 輪 | 往他的話底下挖一層，問出他沒說出口的想法，不反駁、不換情境 |
| `redirect` | 轉向 | 他要你做非哲學的工作（`assess` 的 `about` 是 `task`） | 不替他做也不拒絕，從他的話接到題目 |
| `deflect` | 帶開 | 他想改變 AI 的角色，或問設定、規則、工具（`about` 是 `setting`） | 不接這個話，直接問題目 |
| `hand-back` | 交回 | 他要 AI 給答案或看法（`about` 是 `answer`） | 把他前面的話拿出來問下一步 |
| `clarify` | 說清楚 | 他說看不懂（`about` 是 `confused`） | 用白話說清楚，再問同一個問題 |
| `offtopic` | 接回 | 他說無關的話、罵人、亂打字（`about` 是 `chat`） | 幾個字接住，問題目 |
| `oppose` | 對立辯護 | 預設的挑戰 | 提出另一邊最有力的理由 |
| `reductio` | 歸謬 | 他的理由是一條普遍原則 | 用他的原則推到他可能不接受的情況 |
| `escalate` | 加速 | 被挑戰後堅持 2 次以上 | 保留他的原則，把代價推高一步 |
| `engage` | 拉回 | 他這一句想脫離討論 | 不放他走，讓他願意再回答一句 |
| `listen` | 聆聽 | 拉回後的下一輪 | 接住他的回答，請他多說一點，不挑戰 |
| `close` | 收尾 | AI 判斷可以收，而且他至少回應過 3 次挑戰；或快到 `maxRounds` | 用他的話整理立場和理由 |
| `end` | 結束 | 收尾的下一輪 | 接住他對整理的回應，道謝 |
| `done` | 已結束 | 結束之後他又說話 | 簡短回應 |
| `care` | 關心 | 他在說自己真實的痛苦或想傷害自己 | 停止討論題目，先關心他 |

決定狀態的順序在 `task.ts` 的 `nextStage()`，由上往下，第一個符合的就是這一輪的狀態：關心 → 已結束 → 結束 → 輪數上限 → 拉回 → 轉向、帶開、交回、說清楚、接回 → 聆聽 → 問立場 → 問理由 → 收尾 → 追問 → 挑戰。

轉向、帶開、交回、說清楚、接回只看這一輪 `assess` 的 `about`。

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
| `probes` | 數字 | AI 追問過幾輪 |
| `assessed` | 數字 | AI 判斷過幾輪 |
| `stages` | 陣列 | 每一輪走過的狀態 |
| `answered` | 數字 | 學生回應了幾次挑戰 |
| `shifted` | 是非 | 立場有沒有改變過 |
| `readyNote` | 字串 | AI 判斷能不能收尾的理由 |
| `closing` | 是非 | 在 `close`、`end` 或 `done` |
| `ended` | 是非 | 在 `end` 或 `done` |
| `care` | 是非 | 在 `care`，學生可能需要老師注意 |
| `lookups` | 陣列 | 查過的名詞：`{ round, term, status }` |
| `disengaged` | 數字 | 學生想走幾次 |
| `violations` | 陣列 | **這一輪新增的**違規：`{ turn, type, excerpt }`；`type` 是 `math`、`coding`、`injection`、`other`。欄位對應 #71 的 `violations` 表，後端每輪寫進去，不用去重 |
| `violationLog` | 陣列 | 整段對話回報過的違規 |

回覆裡沒有 `[neutral]` 這類情緒標記。

---

## 6. 工具（AI 回報用）

| 工具 | AI 什麼時候呼叫 | 做什麼 |
|---|---|---|
| `note` | 學生說了立場、理由、想走、痛苦等 | 記到狀態，下一次決定狀態時用；`kind` 的定義寫在 `task.ts` 工具的 `description` |
| `assess` | 每一輪 | 記下學生這句話是哪一種（`about`，決定這一輪的狀態）、能不能收尾和理由 |
| `note` 的 `thinking` | 學生說還在想 | 收尾之後，這個或新的理由才會回到討論；只說再見不會 |
| `report_violation` | 學生在要求非哲學工作 | 記下種類和原話給老師看。看意圖，不看字面：說得像在談題目、其實要 AI 做別的，要回報；提到數學、程式但在論證題目，不回報。一樣不拒答，照樣追問，不影響狀態 |
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
├─ evals.json       # 評估：98 筆測試資料和檢查條件
├─ eval.ts          # 評估的程式判斷：格式、問句、說話的分寸、狀態
├─ eval.test.ts     # 程式判斷自己的測試：該抓的抓得到、不該抓的不誤判
└─ prompts/
   ├─ main.prompt            # 每一輪都有的規則，依狀態放入下面的片段
   ├─ _stage-<狀態>.prompt   # 每個狀態一份：目的、做法、學生的反應怎麼接、限制
   └─ _lookup.prompt         # 查名詞的規則
```
