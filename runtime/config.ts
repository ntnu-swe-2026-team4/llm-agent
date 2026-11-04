// 連到哪個模型：讀 providers/models.json，環境變數可以蓋過（跟後端原本的規則一樣）
//
//   用哪個供應商  LLM_PROVIDER → models.json 裡第一個（mock 以外的）供應商
//                 LLM_PROVIDER=mock：不呼叫模型，給離線開發和測試用
//   網址          <供應商>_BASE_URL → models.json 的 baseUrl
//   模型          呼叫時指定的 model → <供應商>_MODEL → models.json 的 defaultModel
//   key           <供應商>_API_KEY（只放環境變數，不放檔案）
//
//   <供應商> 是 models.json 裡的名稱轉大寫，例：glm → GLM_API_KEY、GLM_MODEL、GLM_BASE_URL
//   呼叫端也可以直接傳設定（ConnectionSettings），有傳的蓋過上面全部，例：後端傳自己 config 裡的 key
//   models.json 每次呼叫都重讀，改了不用重啟
import { exists, readText } from "./files.ts";
import { join } from "node:path";
import { ROOT } from "./prompt.ts";

export const MODELS_FILE = join(ROOT, "providers", "models.json");

interface ProviderEntry {
  baseUrl?: string;
  defaultModel?: string;
  models?: string[];
  /** 每次請求都帶上的參數，例：{ "thinking": { "type": "disabled" } } */
  params?: Record<string, unknown>;
}

export interface Connection {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  params: Record<string, unknown>;
  /** LLM_PROVIDER=mock：不呼叫模型 */
  mock: boolean;
}

function providers(): Record<string, ProviderEntry> {
  if (!exists(MODELS_FILE)) return {};
  return (JSON.parse(readText(MODELS_FILE)) as { providers?: Record<string, ProviderEntry> }).providers ?? {};
}

/** 呼叫端直接給的連線設定；沒給的欄位照環境變數和 models.json */
export interface ConnectionSettings {
  /** models.json 裡的供應商名稱 */
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** 這次連線每個請求都帶上的參數；有給就取代 models.json 的 params */
  params?: Record<string, unknown>;
  /** true：不呼叫模型（跟 LLM_PROVIDER=mock 一樣） */
  mock?: boolean;
}

const env = (name: string) => process.env[name]?.trim() || undefined;

export function connection(settings: ConnectionSettings = {}): Connection {
  const all = providers();
  const chosen = settings.mock ? "mock" : (settings.provider || env("LLM_PROVIDER"))?.toLowerCase();
  if (chosen === "mock") return { provider: "mock", baseUrl: "", apiKey: "", model: "mock", params: {}, mock: true };

  const provider = chosen ?? Object.keys(all).find(p => p !== "mock") ?? "glm";
  const entry = all[provider] ?? {};
  const prefix = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return {
    provider,
    baseUrl: (settings.baseUrl || env(`${prefix}_BASE_URL`) || entry.baseUrl || "").replace(/\/+$/, ""),
    apiKey: settings.apiKey || env(`${prefix}_API_KEY`) || "",
    model: settings.model || env(`${prefix}_MODEL`) || entry.defaultModel || entry.models?.[0] || "",
    params: settings.params ?? entry.params ?? {},
    mock: false,
  };
}

/** 給人看的「供應商/模型」，例：glm/glm-4.6 */
export const describe = (c: Connection) => (c.mock ? "mock（不呼叫模型）" : `${c.provider}/${c.model}`);
