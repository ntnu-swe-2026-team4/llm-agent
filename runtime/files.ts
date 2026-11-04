// 讀 prompt 檔和 models.json
//   一般（bun、node）：從檔案系統讀
//   Cloudflare Workers：沒有檔案系統，改從 bun llm bundle 打包好的內容讀（worker.ts 呼叫 useBundle）
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 框架的根目錄；Workers 上沒有 import.meta.url，改用固定的名字（只當打包內容的前綴） */
export const ROOT = (() => {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    return "/llm-framework";
  }
})();

/** bun llm bundle 產生的內容 */
export interface Bundle {
  /** 相對於框架根目錄的路徑 → 檔案內容（prompt 檔、models.json） */
  files: Record<string, string>;
  /** 預先編譯好的 Handlebars 模板：模板原文 → 編譯結果（Workers 不准在執行時產生程式碼） */
  templates: Record<string, unknown>;
}

let bundle: Bundle | undefined;

export function useBundle(b: Bundle) {
  bundle = b;
}

export const bundled = () => bundle;

const rel = (path: string) => (path.startsWith(ROOT) ? path.slice(ROOT.length) : path).replace(/^[/\\]+/, "").replaceAll("\\", "/");

export function exists(path: string): boolean {
  if (!bundle) return existsSync(path);
  const p = rel(path);
  return p in bundle.files || Object.keys(bundle.files).some(f => f.startsWith(`${p}/`));
}

export function readText(path: string): string {
  if (!bundle) return readFileSync(path, "utf8");
  const text = bundle.files[rel(path)];
  if (text === undefined) throw new Error(`打包內容裡沒有 ${rel(path)}，請重新執行 bun llm bundle`);
  return text;
}

/** 資料夾裡的檔名（不含子資料夾） */
export function list(dir: string): string[] {
  if (!bundle) return existsSync(dir) ? readdirSync(dir) : [];
  const prefix = `${rel(dir)}/`;
  return Object.keys(bundle.files)
    .filter(f => f.startsWith(prefix) && !f.slice(prefix.length).includes("/"))
    .map(f => f.slice(prefix.length));
}
