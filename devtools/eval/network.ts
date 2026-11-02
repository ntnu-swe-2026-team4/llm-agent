// 評估時碰到網路問題（斷線、逾時、限流、伺服器忙）：等一下，整個步驟重來
//   一個步驟 = AI 回一輪、對方說一句、評審評一條、產生一批測試資料
//   對話是不記狀態的（每輪帶入對話紀錄和狀態），所以重來一輪不會影響前面的輪
//   額度用完、key 錯這類重來也沒用的錯誤，照樣丟出去
import { LLMError } from "../../runtime/errors.ts";

const WAITS_MS = [10_000, 30_000];

/** 是不是網路的問題（等一下再試可能就好了） */
export function isNetworkError(e: unknown): boolean {
  if (!(e instanceof LLMError)) return false;
  if (e.code === "llm_timeout" || e.code === "llm_rate_limited") return true;
  return e.code === "llm_unavailable" && (e as { retryable?: boolean }).retryable === true;
}

/** 跑 step；碰到網路問題就等一下重來，最多再試 waits.length 次 */
export async function withRetry<T>(what: string, step: () => Promise<T>, log: (line: string) => void, waits = WAITS_MS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await step();
    } catch (e) {
      if (!isNetworkError(e) || attempt >= waits.length) throw e;
      const wait = waits[attempt]!;
      log(`${what}：${(e as Error).message.slice(0, 80)}，${wait / 1000} 秒後重來（第 ${attempt + 1}/${waits.length} 次）`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}
