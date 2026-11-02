// 評估的即時輸出：promptfoo 開跑後幾乎不印東西，所以由執行任務和評審的 provider 自己印每一步
//   寫到 stderr；網頁把 promptfoo 的輸出（log.txt）即時轉給瀏覽器，終端機跑 bun llm eval 也看得到
import { onRetry } from "../../runtime/model.ts";

export function evalLog(line: string) {
  process.stderr.write(line + "\n");
}

/** 壓成一行，太長就截掉（完整內容在結果裡） */
export const oneLine = (text: string, max = 160) => {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export const seconds = (t0: number) => `${((performance.now() - t0) / 1000).toFixed(1)} 秒`;

/** 碰到限流等錯誤、在等待重試時也印出來，不然看起來像卡住（只在 promptfoo 的程序裡呼叫） */
export const logRetries = () => onRetry(line => evalLog(`    ⟳ ${line}`));
