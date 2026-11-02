// socratic-dialogue 的程式判斷：在網頁「比較版本」的 ② 選「用程式檢查」，就能用這裡的名稱
import { defineChecks } from "../../devtools/eval/checks.ts";

export default defineChecks("socratic-dialogue", {
  // "名稱": ({ transcript, progress }) => true,   // transcript 是整段對話；回傳 true / false，或 { pass, reason }
  "記錄到立場和理由": ({ progress }) => ({
    pass: progress.coverage.claim && progress.coverage.reason,
    reason: `對話結束時記錄到的：${Object.entries(progress.coverage).filter(([, v]) => v).map(([k]) => k).join("、") || "沒有"}`,
  }),
});
