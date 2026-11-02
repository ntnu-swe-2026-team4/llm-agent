#!/usr/bin/env bash
# llm-framework 教學 demo：從空的開始，一步一步把兩個範例做出來
#   第一段（1–9）   單次型 debate-judge：宣告任務、寫 dotprompt、寫測試、評估要在哪裡做
#   第二段（10–15） 對話型 socratic-dialogue：只講對話型多出來的東西（狀態、工具、依階段換 prompt）
#
#   ./demo.sh             完整 demo。會呼叫模型的步驟會先問你要不要跑，需要 .env 裡的 key
#   ./demo.sh --no-model  不呼叫模型（預演用，不需要 key）
#
# 腳本會把專案複製到暫存資料夾，所有修改都在那裡做，不會動到專案本身。
# 黃字是這一步要講的話，灰字是實際執行的指令，綠字是這一步新寫的內容。每一步按 Enter 才繼續。

set -u
SRC="$(cd "$(dirname "$0")" && pwd)"

NO_MODEL=0
[ "${1:-}" = "--no-model" ] && NO_MODEL=1

[ -d "$SRC/node_modules" ] || { echo "找不到 node_modules，請先在專案資料夾執行 bun install"; exit 1; }

step()  { printf '\n\033[1;36m━━ %s ━━\033[0m\n' "$1"; }
say()   { printf '\033[33m%s\033[0m\n' "$1"; }
quiet() { grep -v '^\$ bun cli\.ts'; }                           # 濾掉 bun 自己重印的那一行指令
run()   { printf '\033[2m$ %s\033[0m\n' "$*"; "$@" 2>&1 | quiet; }
show()  { printf '\033[2m$ %s\033[0m\n' "$1"; bash -c "$1" 2>&1 | quiet; }   # 含管線的指令
pause() { printf '\n'; read -r -p '（按 Enter 繼續）' _ || true; }

# 會呼叫模型的指令：--no-model 時不跑；否則先問
model() {
  printf '\033[2m$ %s\033[0m\n' "$*"
  if [ "$NO_MODEL" = 1 ]; then printf '\033[2m（--no-model：略過）\033[0m\n'; return; fi
  local a=""
  read -r -p '（這一步會呼叫模型。按 Enter 執行，輸入 s 跳過）' a || true
  [ "$a" = s ] || "$@"
}

# 顯示一個檔案這一步改了什麼：新檔整份印出，舊檔只印有變的幾行
changes() {  # $1 舊檔（可能不存在） $2 新檔
  printf '\033[2m── %s\033[0m\n' "${2#"$WORK"/}"
  if [ -s "$1" ]; then
    diff -U1 "$1" "$2" | tail -n +3 | grep -v '^@@' | sed -e $'s/^+.*/\033[32m&\033[0m/' -e $'s/^-.*/\033[31m&\033[0m/'
  else
    sed -e $'s/^/\033[32m+ /' -e $'s/$/\033[0m/' "$2"
  fi
}

# 把標準輸入寫成檔案（教學過程中的半成品）
write() {  # $1 相對於暫存資料夾的路徑
  mkdir -p "$(dirname "$WORK/$1")"
  cp "$WORK/$1" "$OLD" 2>/dev/null || : > "$OLD"
  cat > "$WORK/$1"
  changes "$OLD" "$WORK/$1"
}

# 把檔案寫成範例裡的最終樣子
final() {  # $1 範例名稱/檔案路徑
  mkdir -p "$(dirname "$WORK/tasks/$1")"
  cp "$WORK/tasks/$1" "$OLD" 2>/dev/null || : > "$OLD"
  cp "$ANSWER/$1" "$WORK/tasks/$1"
  changes "$OLD" "$WORK/tasks/$1"
}

# ── 準備暫存副本：把要做的兩個範例拿掉，留一份當答案 ──
WORK="$(mktemp -d /tmp/llm-demo.XXXXXX)"
ANSWER="$(mktemp -d /tmp/llm-demo-answer.XXXXXX)"
OLD="$(mktemp /tmp/llm-demo-old.XXXXXX)"
(cd "$SRC" && tar cf - --exclude=./node_modules --exclude=./.promptfoo --exclude=./.runs --exclude=./.env .) | (cd "$WORK" && tar xf -)
ln -s "$SRC/node_modules" "$WORK/node_modules"
cd "$WORK"
for name in debate-judge socratic-dialogue; do
  mv "examples/$name" "$ANSWER/$name"
  sed -i "/examples\/$name\/task.ts/d; /^  \"$name\": /d" index.ts
done
J=tasks/debate-judge
S=tasks/socratic-dialogue

if [ "$NO_MODEL" = 0 ]; then
  step "開始前　放 key"
  say "會呼叫模型的步驟需要 key。在專案資料夾的 .env 寫一行（已列入 .gitignore，不會進 git）："
  say "  GLM coding plan：GLM_API_KEY=你的 key"
  say "  OpenCode Go：    OPENCODE_API_KEY=你的 key，再加 LLM_MODEL=opencode-go/glm-5.3-flash 和 JUDGE_MODEL=opencode-go/glm-5.3-flash"
  if ! grep -Eqs '^[A-Z_]+_API_KEY=.+' "$SRC/.env"; then
    printf '\n❌ %s 裡沒有 key。放好之後再執行一次，或先用 ./demo.sh --no-model 預演。\n' "$SRC/.env"
    exit 1
  fi
  say "找到 key 了。"
  pause
fi

# ═══════════════════════ 第一段：單次型 debate-judge ═══════════════════════

step "1/15　框架裡沒有任務"
say "框架本身不含正式任務，只附範例。這次 demo 先把 debate-judge 和 socratic-dialogue 兩個範例拿掉，從空的開始把它們做出來。"
show "bun llm | tail -3"
say "先做「辯論裁判」：給它一段發言，它交回固定格式的評分。"
pause

step "2/15　建立任務的骨架"
say "一個任務就是 tasks/ 底下的一個資料夾。new 會建好三個檔案，並註冊到後端的入口。"
show "bun llm new debate-judge | head -1"
run ls $J $J/prompts
say "task.ts 宣告任務、prompts/ 放 dotprompt、task.test.ts 是測試。"
pause

step "3/15　宣告輸入"
say "先改 task.ts 的 input：裁判要知道辯論環節和這一段發言。example 是一份範例輸入，後面每個指令都用它。"
write $J/task.ts <<'EOF'
// 階段 3 裁判：評一段辯論發言的論證品質（立場盲：輸入裡沒有立場）
import { defineOneShot, Type } from "../../runtime/index.ts";

export default defineOneShot({
  input: Type.Object({
    phase: Type.Enum(["opening", "cross", "rebuttal", "closing"], { description: "辯論環節" }),
    speech: Type.String({ description: "這一段發言" }),
  }),

  // 輸出先留骨架的，第 6 步再改
  output: Type.Object({
    summary: Type.String({ maxLength: 100 }),
  }),

  example: {
    phase: "rebuttal",
    speech: "對方說人數多就該優先，但如果五個人是自願冒險、一個人是無辜路人，單看人數就忽略了責任歸屬。",
  },

  exampleOutput: { summary: "範例輸出" },
});
EOF
say "render 印出實際會送給模型的內容，不呼叫模型。"
run bun llm render debate-judge
say "注意：沒有 [user] 那一段。骨架的 prompt 用的是 {{text}}，這個欄位已經不存在了。"
say "dotprompt 遇到不存在的欄位不會報錯，只會變成空的。所以改完 prompt 一定要 render 看一次。"
pause

step "4/15　dotprompt：角色、欄位、設定"
say "prompt 寫在 prompts/main.prompt。檔頭的 config 是給模型的設定；{{role}} 切換 system 和 user；{{欄位}} 插入輸入的值。"
write $J/prompts/main.prompt <<'EOF'
---
config:
  temperature: 0
---
{{role "system"}}
你是辯論比賽的裁判，只評論證品質。用繁體中文寫評語。

{{role "user"}}
環節：{{phase}}
發言：{{speech}}
EOF
show "bun llm render debate-judge | head -9"
say "[user] 回來了，欄位被填成範例輸入的值。"
pause

step "5/15　dotprompt：片段"
say "檔名用 _ 開頭的 .prompt 是片段，用 {{> 名稱}} 插入。評分標準寫成這個任務自己的片段 _criteria.prompt。"
final debate-judge/prompts/_criteria.prompt
say "所有任務共用的片段放在 shared/prompts/，例如「不評論立場」的規則 _no-judgment.prompt。兩個都插進 main.prompt："
write $J/prompts/main.prompt <<'EOF'
---
config:
  temperature: 0
---
{{role "system"}}
你是辯論比賽的裁判，只評論證品質。用繁體中文寫評語。

{{> no-judgment}}

{{> criteria}}

{{role "user"}}
環節：{{phase}}
發言：{{speech}}
EOF
show "bun llm render debate-judge | sed -n '/\\[system\\]/,/\\[user\\]/p' | sed '\$d'"
pause

step "6/15　宣告輸出，讓 AI 交回固定格式"
say "output 是 AI 要交回的格式，照前端 types.ts 的型別寫。框架會把這個格式附在 system 的最後，要模型只回 JSON；格式不對會退回重問。"
final debate-judge/task.ts
say "所以 prompt 不用自己寫輸出格式，專心寫評分的規則："
final debate-judge/prompts/main.prompt
show "bun llm render debate-judge | tail -12"
say "try 用範例輸入真的呼叫一次模型："
model bun llm try debate-judge
pause

step "7/15　dotprompt：版本"
say "想試另一種寫法，不要直接改 main.prompt，另存成 main.<名稱>.prompt，<名稱> 就是版本名稱。"
final debate-judge/prompts/main.brief.prompt
show "bun llm render debate-judge brief | grep -E '版本：|^notes '"
say "render 和 try 後面加版本名稱就會用那一版；後面的評估會把所有版本放在一起比。"
pause

step "8/15　測試（不呼叫模型）"
say "每個任務都會自動被檢查：範例符合格式、每個版本都能渲染、多給或少給欄位會被擋下。"
say "任務自己的規則寫在 task.test.ts。這裡寫兩條：輸入有進到 prompt、想偷帶立場會被擋下。"
final debate-judge/task.test.ts
show "bun test $J 2>&1 | grep -E '^\\((pass|fail)\\)| pass| fail'"
pause

step "9/15　評估：在網頁介面做"
say "到這裡整個任務寫完了。check 是型別檢查加全部測試："
show "bun run check 2>&1 | grep -E 'error|\\(fail\\)| pass| fail'"
say "做出來的和 examples/debate-judge/ 一模一樣（diff 沒有輸出就是一樣）："
run diff -r $J "$ANSWER/debate-judge"
say "測試只能看 prompt 的文字。模型實際表現得好不好，用評估：每筆測試資料 × 每個 prompt 版本各跑一次，評審 AI 再依標準打分（交給 promptfoo 執行）。"
say "測試資料和標準在網頁介面（bun llm ui）的「評估」分頁編輯，存在任務的 evals.json。測試資料可以按「產生」，讓 AI 照 task.ts 的輸入格式產生，再自己改。標準有四種："
say "  是非題、評分（0–1 分）、版本比較（從這次跑的版本選最好的）、程式判斷（寫在任務的 eval.ts）。"
say "勾好要跑的版本和測試資料，按「開始評估」；結果表格、每條標準的理由、匯出都在同一頁。"
pause

# ═══════════════════════ 第二段：對話型 socratic-dialogue ═══════════════════════

step "10/15　對話型的骨架"
say "第二種任務是對話型：多輪，AI 記得前文。現在做「蘇格拉底式追問」。宣告、prompt、測試、評估的寫法都和剛才一樣，下面只講多出來的東西。"
show "bun llm new socratic-dialogue --dialogue | head -1"
pause

step "11/15　狀態和工具"
say "對話型多了四樣宣告："
say "  state        對話開始時的狀態"
say "  tools        AI 可以呼叫的工具，用來更新狀態"
say "  promptInput  每一輪 AI 回覆前呼叫，回傳這一輪 prompt 拿到的資料"
say "  progress     後端要進度時回傳的東西"
say "這裡的狀態是「學生說過哪幾種話」，AI 用 record_progress 回報。"
write $S/task.ts <<'EOF'
// 階段 1 個人調查：蘇格拉底式追問
import { defineDialogue, Type } from "../../runtime/index.ts";

type Kind = "claim" | "reason" | "evidence" | "counter";

export const MAX_ROUNDS = 20;

export default defineDialogue({
  input: Type.Object({
    question: Type.String({ description: "題目情境" }),
    axes: Type.Array(Type.Object({ left: Type.String(), right: Type.String() }), { description: "價值軸" }),
  }),

  example: {
    question: "電車難題：一台失控電車即將撞上五個人，你可以拉桿讓它轉向，但另一條軌道上有一個人。你會拉嗎？",
    axes: [{ left: "看結果", right: "看原則" }],
  },

  state: () => ({
    coverage: { claim: false, reason: false, evidence: false, counter: false } as Record<Kind, boolean>,
    records: [] as { round: number; kind: Kind; quote: string }[],
    round: 0,
  }),

  // 每輪 AI 回覆前：這一輪 main.prompt 拿到的資料
  promptInput: (input, s, round) => {
    s.round = round;
    return { ...input, round, maxRounds: MAX_ROUNDS };
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

  progress: (s, round) => ({ rounds: round, maxRounds: MAX_ROUNDS, coverage: { ...s.coverage } }),
});
EOF
say "prompt 裡多用一個 dotprompt 語法：{{#each}} 逐項列出陣列。round 和 maxRounds 是 promptInput 給的。"
write $S/prompts/main.prompt <<'EOF'
---
config:
  temperature: 0.7
---
{{role "system"}}
你是一位蘇格拉底式的提問者，和一位學生一對一討論下面的題目。用繁體中文回答。

## 題目
{{question}}

## 價值軸
{{#each axes}}
- {{left}} ↔ {{right}}
{{/each}}

{{> no-judgment}}

## 說話方式
- 每次只問一個問題
- 回覆不超過三句話
- 學生用了模糊的詞（例如「應該」「公平」）才請他說明；不要問題目本身的字面意思

## 記錄
學生清楚說出主張、理由、例子、或對反例的回應時，先呼叫 record_progress，再回覆學生。

## 第 {{round}} 輪（最多 {{maxRounds}} 輪）
EOF
run bun llm render socratic-dialogue
pause

step "12/15　每一輪依狀態換 prompt"
say "框架每一輪都會重新呼叫 promptInput、重新渲染 prompt。所以可以依狀態決定這一輪 AI 該做什麼："
say "還沒立場 → 問立場；有立場 → 問理由；有理由 → 丟反例；都有了或快到輪數上限 → 確認。"
final socratic-dialogue/task.ts
say "每個階段的指令各寫成一個片段，main.prompt 用 {{#ifEquals}} 只放進這一輪的那一個："
for f in _stage-ask-stance _stage-ask-reason _stage-challenge _stage-confirm; do final socratic-dialogue/prompts/$f.prompt; done
final socratic-dialogue/prompts/main.prompt
show "bun llm render socratic-dialogue | tail -2"
say "第一輪學生還沒表明立場，所以是「問立場」。"
pause

step "13/15　不呼叫模型，測「狀態變了，prompt 跟著變」"
say "測試裡可以自己準備狀態再 render：假設已經記錄到立場和理由，第三輪的 prompt 應該是丟反例。工具的 run 也可以直接呼叫來測。"
final socratic-dialogue/task.test.ts
show "bun test $S 2>&1 | grep -E '^\\((pass|fail)\\)| pass| fail'"
say "真的對話看看。直接打字，空白行結束；每輪下面的「進度」就是 progress 回傳的東西："
model bun llm try socratic-dialogue
pause

step "14/15　對話型的評估"
say "範例還有一個比較用的版本："
final socratic-dialogue/prompts/main.strict.prompt
show "bun run check 2>&1 | grep -E 'error|\\(fail\\)| pass| fail'"
say "做出來的和 examples/socratic-dialogue/ 一模一樣："
run diff -r $S "$ANSWER/socratic-dialogue"
say "對話型的每筆測試資料，除了輸入還有「對話的另一方」和對話輪數：另一個 AI 照這段描述扮演跟任務對話的人，評審看整段對話。按「產生」時會一起寫好。"
pause

step "15/15　整段都沒有改框架"
say "兩個任務從頭到尾只動了自己的資料夾。框架（runtime/、devtools/）和開始前比對，沒有差異："
run diff -r "$SRC/runtime" runtime
run diff -r "$SRC/devtools" devtools
say "入口 index.ts 只多了 new 自動加的註冊："
show "grep -n 'tasks/' index.ts"

printf '\n'
say "做你自己的任務：bun llm new <名稱>（對話型加 --dialogue），再照上面的順序寫。完整說明在 README.md。"
say "這次的修改都在暫存資料夾：$WORK"
say "專案本身沒有被改動。"
printf '\n'
