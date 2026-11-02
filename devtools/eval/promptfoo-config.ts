// promptfoo 讀的設定檔（bun llm eval 和網頁的「比較版本」都用它）
//   LLM_EVAL_TASK：要評估的任務；LLM_EVAL_VARIANTS：只跑這些版本（逗號分隔，沒設就是全部）
import { logRetries } from "./log.ts";
import { evalConfig } from "./promptfoo.ts";

logRetries();
const picked = process.env.LLM_EVAL_VARIANTS?.split(",").map(s => s.trim()).filter(Boolean);
export default evalConfig(process.env.LLM_EVAL_TASK ?? "", picked);
