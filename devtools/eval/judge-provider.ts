// promptfoo 的評審 provider：評審 AI，模型用 JUDGE_MODEL（沒設就跟受測任務同一個）
import type { ApiProvider, ProviderResponse } from "promptfoo";
import { askJudge, judgeModelName } from "./judge.ts";
import { evalLog, oneLine, seconds } from "./log.ts";
import { withRetry } from "./network.ts";

export default class JudgeProvider implements ApiProvider {
  id() {
    return `judge:${judgeModelName()}`;
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    const start = performance.now();
    try {
      const output = await withRetry("    評審", () => askJudge(prompt), evalLog);
      evalLog(`    評審（${seconds(start)}）：${oneLine(output, 120)}`);
      return { output };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      evalLog(`    評審失敗（${seconds(start)}）：${oneLine(message)}`);
      return { error: message };
    }
  }
}
