// 網頁預覽用：找出 prompt 裡用到、但資料裡沒有的欄位
//   .prompt 裡的欄位名稱打錯（例：{{referenes}}）時，dotprompt 不會報錯，只會渲染成空的。
//   這裡把 prompt 用到的欄位跟實際的資料比對，列出對不上的。
import { join } from "node:path";
import { partials, read, SHARED, variantFile, type PromptOverrides } from "../runtime/prompt.ts";


export interface UnknownField {
  /** prompt 裡寫的名稱 */
  name: string;
  /** 出現在哪個檔案（main.prompt、_stage-ask-stance.prompt…） */
  file: string;
}

const HELPERS = new Set(["role", "if", "unless", "each", "with", "else", "ifEquals", "unlessEquals", "json", "history", "section", "media"]);
const SKIP = /^(this|@|\.\.?\/|true$|false$|-?\d)/;

/** 只看 {{ }} 裡的識別字；字串、數字、this、@index 這些跳過 */
function identifiers(expr: string): string[] {
  return expr
    .replace(/"[^"]*"|'[^']*'/g, " ")
    .split(/\s+/)
    .filter(w => w && !SKIP.test(w) && /^[A-Za-z_]/.test(w));
}

export function unknownFields(
  taskDir: string,
  data: Record<string, unknown>,
  variant = "main",
  overrides?: PromptOverrides,
): UnknownField[] {
  const dir = join(taskDir, "prompts");
  const sources = new Map<string, [file: string, text: string]>();
  // 片段：任務自己的會蓋過 shared 的同名片段（跟 render 一樣）
  for (const d of [SHARED, dir]) {
    for (const [name, text] of partials(d, overrides)) sources.set(name, [`_${name}.prompt`, text]);
  }
  const mainFile = variantFile(taskDir, variant);
  const found: UnknownField[] = [];
  const seen = new Set<string>();

  const walk = (file: string, text: string, scope: unknown, depth: number) => {
    if (depth > 10) return;
    const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
    const stack: unknown[] = [scope];
    const has = (name: string) => {
      const cur = stack[stack.length - 1];
      return cur !== null && typeof cur === "object" && name.split(".")[0]! in (cur as object);
    };
    const value = (name: string) => (stack[stack.length - 1] as Record<string, unknown> | undefined)?.[name.split(".")[0]!];
    const report = (name: string) => {
      const key = `${file}:${name}`;
      if (!seen.has(key)) { seen.add(key); found.push({ name, file }); }
    };

    for (const m of body.matchAll(/\{\{~?\s*([#/>^]?)\s*([^}]*?)\s*~?\}\}/g)) {
      const [, sigil, expr] = m as unknown as [string, string, string];
      if (expr.startsWith("!")) continue;
      if (sigil === "/") { if (stack.length > 1) stack.pop(); continue; }
      if (sigil === ">") {
        const partial = sources.get(expr.split(/\s+/)[0]!);
        if (partial) walk(partial[0], partial[1], stack[stack.length - 1], depth + 1);
        continue;
      }
      const words = identifiers(expr);
      const helper = words[0] && HELPERS.has(words[0]) ? words.shift() : undefined;
      for (const w of words) if (!has(w)) report(w);
      if (sigil === "#") {
        const target = words[0];
        if (helper === "each") {
          const arr = target ? value(target) : undefined;
          stack.push(Array.isArray(arr) ? (arr[0] ?? {}) : {});
        } else if (helper === "with") {
          stack.push(target ? value(target) : {});
        } else {
          stack.push(stack[stack.length - 1]);
        }
      }
    }
  };

  walk(mainFile.slice(dir.length + 1), read(mainFile, overrides), data, 0);
  return found;
}
