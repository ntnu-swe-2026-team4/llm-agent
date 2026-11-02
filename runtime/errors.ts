// 框架只丟這一種錯誤：LLMError。後端看 status 回 HTTP 狀態碼、看 code 決定訊息
//   code 和 status 跟後端（server/src/services/llm.ts）原本的 LlmError 一樣，後端可以直接對應

export type LLMErrorCode =
  /** 輸入不符合 task.ts 的 input，或對話紀錄的順序不對（呼叫端的 bug） */
  | "llm_invalid_input"
  /** 沒有設定 API key */
  | "llm_not_configured"
  /** 供應商限流（太多請求），等一下再試會好 */
  | "llm_rate_limited"
  /** 供應商出錯、額度用完、網路斷 */
  | "llm_unavailable"
  /** 太久沒有回應 */
  | "llm_timeout"
  /** 單次型：重問幾次，模型還是沒交出符合 output 的結果 */
  | "llm_no_result";

const STATUS: Record<LLMErrorCode, number> = {
  llm_invalid_input: 422,
  llm_not_configured: 503,
  llm_rate_limited: 429,
  llm_unavailable: 503,
  llm_timeout: 503,
  llm_no_result: 503,
};

export class LLMError extends Error {
  /** 建議的 HTTP 狀態碼 */
  readonly status: number;

  constructor(
    readonly code: LLMErrorCode,
    message: string,
    /** 串流已經送出部分文字之後才出錯（後端這時要送 SSE 的 error 事件，不能再回 HTTP 錯誤） */
    readonly midStream = false,
  ) {
    super(message);
    this.name = "LLMError";
    this.status = STATUS[code];
  }
}
