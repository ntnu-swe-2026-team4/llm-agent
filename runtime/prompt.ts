// 渲染任務的 prompts/（dotprompt 格式）
//   main.prompt          主 prompt
//   main.<版本>.prompt   同一個任務的其他寫法
//   _名稱.prompt         片段，用 {{> 名稱}} 插入；shared/prompts/ 的片段每個任務都能用
import { Dotprompt } from "dotprompt";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SHARED = join(ROOT, "shared", "prompts");

export interface Rendered {
  system: string;
  user: string;
  /** .prompt 檔頭的 config（temperature 等） */
  config: { temperature?: number; maxOutputTokens?: number };
}

/** 還沒存檔的內容：檔案的完整路徑 → 內容。網頁介面邊打邊預覽時用 */
export type PromptOverrides = Record<string, string>;

export const read = (path: string, overrides?: PromptOverrides) => overrides?.[path] ?? readFileSync(path, "utf8");

export function partials(dir: string, overrides?: PromptOverrides): [string, string][] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.startsWith("_") && f.endsWith(".prompt"))
    .map(f => [f.slice(1, -".prompt".length), read(join(dir, f), overrides)]);
}

/** prompts/ 裡有哪些版本：main.prompt → "main"，main.strict.prompt → "strict" */
export function variants(taskDir: string): string[] {
  return readdirSync(join(taskDir, "prompts"))
    .filter(f => /^main(\.[^.]+)?\.prompt$/.test(f))
    .map(f => (f === "main.prompt" ? "main" : f.slice("main.".length, -".prompt".length)));
}

export const variantFile = (taskDir: string, variant: string) =>
  join(taskDir, "prompts", variant === "main" ? "main.prompt" : `main.${variant}.prompt`);

export async function render(
  taskDir: string,
  data: Record<string, unknown>,
  variant = "main",
  overrides?: PromptOverrides,
): Promise<Rendered> {
  const dir = join(taskDir, "prompts");
  const file = variantFile(taskDir, variant);
  if (!existsSync(file) && overrides?.[file] === undefined) {
    throw new Error(`找不到版本「${variant}」，現有版本：${variants(taskDir).join("、")}`);
  }

  const dp = new Dotprompt();
  for (const [name, source] of [...partials(SHARED, overrides), ...partials(dir, overrides)]) dp.definePartial(name, source);
  const source = read(file, overrides);
  const meta = await dp.renderMetadata(source);
  const rendered = await dp.render(source, { input: data });
  const text = (role: string) =>
    rendered.messages
      .filter(m => m.role === role)
      .map(m => m.content.map((c: { text?: string }) => c.text ?? "").join("").trim())
      .join("\n\n");
  return { system: text("system"), user: text("user"), config: (meta.config ?? {}) as Rendered["config"] };
}
