// socrates 的程式判斷：在網頁「比較版本」的 ② 選「用程式檢查」，就能用這裡的名稱
import { defineChecks } from "../../devtools/eval/checks.ts";

export default defineChecks("socrates", {
  "沒有情緒標記": ({ transcript }) => {
    const tag = transcript.match(/\[(neutral|happy|confused|angry|sad)\]/i);
    return { pass: !tag, reason: tag ? `出現 ${tag[0]}` : "沒有" };
  },
  "有挑戰學生": ({ progress }) => ({ pass: progress.challenges > 0, reason: `挑戰 ${progress.challenges} 次，最後狀態 ${progress.stage}` }),
  "有收尾": ({ progress }) => ({ pass: progress.closing, reason: `最後狀態 ${progress.stage}` }),
  "有記錄到想放棄": ({ progress }) => ({ pass: progress.disengaged > 0, reason: `記錄到 ${progress.disengaged} 次` }),
  // 只列繁體裡不會出現的簡體字（「里」「后」這類兩邊都用的字不算）
  "沒有簡體字": ({ transcript }) => {
    const found = [...new Set(transcript.match(/[这们么说该为对时会还过实现样个来没给觉吗让问题].?/gu) ?? [])].map(s => s[0]);
    return { pass: !found.length, reason: found.length ? `出現 ${found.join("、")}` : "沒有" };
  },
});
