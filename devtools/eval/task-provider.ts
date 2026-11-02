// promptfoo 的 provider：用正式的執行路徑跑任務，交給評審 AI 評分
//   prompt = 要測的版本名稱（main、strict…）
//   單次型：vars.input → 輸出 JSON
//   對話型：對方是固定台詞（vars.script），或另一個 AI 照 vars.partner 的描述扮演、最多 vars.turns 輪 → 整段對話
//          任務宣告 opener: "ai" 時 AI 先開口，否則對方先說。到了上限就切斷，不另外收尾
import type { ApiProvider, CallApiContextParams, ProviderOptions, ProviderResponse } from "promptfoo";
import { all as tasks } from "../../index.ts";
import type { DialogueTask, OneShotTask, Registered } from "../../runtime/define.ts";
import { reply, type HistoryMessage } from "../../runtime/dialogue.ts";
import { runOneShot } from "../../runtime/oneshot.ts";
import { evalLog, oneLine, seconds } from "./log.ts";
import { withRetry } from "./network.ts";
import { partner } from "./partner/partner.ts";

/** 對話型：跑一段對話，回傳整段文字和最後的進度 */
async function converse(task: Registered<DialogueTask>, input: unknown, variant: string, vars: Record<string, unknown>, tag: string) {
  // 對方：固定台詞（一則一則照順序送），或另一個 AI 照描述扮演（到輪數上限就切斷）
  const script = vars.script ? (JSON.parse(String(vars.script)) as string[]) : null;
  const limit = script ? script.length : Number(vars.turns);
  const partnerInput = { input: JSON.stringify(input, null, 2), partner: String(vars.partner ?? "") };

  // 兩邊各有自己的對話紀錄：任務那邊對方是 user；對方那邊任務是 user
  const history: HistoryMessage[] = [];
  const partnerHistory: HistoryMessage[] = [];
  let state: unknown;
  let progress: unknown;
  const lines: string[] = [];

  const aiSays = async (label: string) => {
    const t0 = performance.now();
    // 不記狀態：同一份對話紀錄和狀態再送一次，就是重來這一輪
    const turn = await withRetry(`${tag} ${label}`, () => reply(task, input as never, { history, state }, { variant }).result, evalLog);
    state = turn.state;
    progress = turn.progress;
    history.push({ role: "assistant", text: turn.text });
    partnerHistory.push({ role: "user", text: turn.text });
    lines.push(`AI：${turn.text}`);
    evalLog(`${tag} ${label}（${seconds(t0)}）：${oneLine(turn.text)}`);
  };

  // 任務宣告 opener: "ai" 的話，AI 先開口
  if (task.opener === "ai") await aiSays("AI 開場");
  else partnerHistory.push({ role: "user", text: "對話開始，請說出你的第一則訊息。" });

  for (let i = 0; i < limit; i++) {
    const t0 = performance.now();
    const line = script
      ? script[i]!
      : (await withRetry(`${tag} 第 ${i + 1}/${limit} 輪 對方`, () => reply(partner, partnerInput, { history: partnerHistory }).result, evalLog)).text.trim();
    history.push({ role: "user", text: line });
    partnerHistory.push({ role: "assistant", text: line });
    lines.push(`對方：${line}`);
    evalLog(`${tag} 第 ${i + 1}/${limit} 輪 對方${script ? "（固定台詞）" : `（${seconds(t0)}）`}：${oneLine(line)}`);
    await aiSays(`第 ${i + 1}/${limit} 輪 AI`);
  }
  return { transcript: lines.join("\n"), progress };
}

export default class TaskProvider implements ApiProvider {
  private name: string;

  constructor(options: ProviderOptions) {
    this.name = options.config?.task;
  }

  id() {
    return `task:${this.name}`;
  }

  async callApi(prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    const task = (tasks as Record<string, Registered>)[this.name]!;
    const variant = prompt.trim() || "main";
    const vars = context?.vars ?? {};
    const input = JSON.parse(String(vars.input));
    // 即時輸出的每一行都標上「版本｜測試資料」
    const tag = `[${variant}｜${context?.test?.description ?? "?"}]`;
    const start = performance.now();
    evalLog(`${tag} 開始`);
    try {
      if (task.kind === "oneshot") {
        const { output, stats } = await withRetry(tag, () => runOneShot(task as Registered<OneShotTask>, input, { variant }), evalLog);
        const text = typeof output === "string" ? output : JSON.stringify(output);
        evalLog(`${tag} 完成（${seconds(start)}）：${oneLine(text)}`);
        return { output: text, metadata: { stats } };
      }
      const { transcript, progress } = await converse(task as Registered<DialogueTask>, input, variant, vars, tag);
      evalLog(`${tag} ${vars.script ? "台詞送完" : "到輪數上限"}，對話切斷（${seconds(start)}），交給評審`);
      return { output: transcript, metadata: { progress } };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      evalLog(`${tag} 失敗（${seconds(start)}）：${oneLine(message)}`);
      return { error: message };
    }
  }
}
