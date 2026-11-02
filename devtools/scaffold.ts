// 建立、刪除正式任務（tasks/）：bun llm new 和網頁介面共用
//   建立：複製 devtools/templates/<類型>，並註冊到 index.ts
//   刪除：從 index.ts 拿掉註冊，再刪資料夾。examples/ 的範例不能刪
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LLMError } from "../runtime/errors.ts";
import { camel } from "../runtime/llm.ts";
import { ROOT } from "../runtime/prompt.ts";

export type TaskKind = "oneshot" | "dialogue";

const NAME = /^[a-z][a-z0-9-]*$/;
const INDEX = join(ROOT, "index.ts");
const IMPORT_MARK = "// ↑ 任務的 import";
const ENTRY_MARK = "  // ↑ 任務清單";


function checkName(name: string) {
  if (!NAME.test(name)) throw new LLMError("llm_invalid_input", "任務名稱只能用小寫英文、數字、減號，並以英文字母開頭，例：argument-summary");
}

export function createTask(name: string, kind: TaskKind) {
  checkName(name);
  const dest = join(ROOT, "tasks", name);
  if (existsSync(dest)) throw new LLMError("llm_invalid_input", `tasks/${name} 已經存在`);

  cpSync(join(ROOT, "devtools", "templates", kind), dest, { recursive: true });
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      writeFileSync(p, readFileSync(p, "utf8").replaceAll("__NAME__", name));
      renameSync(p, p.replace(/\.tmpl$/, ""));
    }
  };
  walk(dest);

  const id = camel(name);
  writeFileSync(INDEX, readFileSync(INDEX, "utf8")
    .replace(IMPORT_MARK, `import ${id} from "./tasks/${name}/task.ts";\n${IMPORT_MARK}`)
    .replace(ENTRY_MARK, `  "${name}": ${id},\n${ENTRY_MARK}`));
}

export function removeTask(name: string) {
  checkName(name);
  const dir = join(ROOT, "tasks", name);
  if (!existsSync(dir)) throw new LLMError("llm_invalid_input", `tasks/${name} 不存在（examples/ 的範例不能刪）`);

  const id = camel(name);
  const before = readFileSync(INDEX, "utf8");
  const after = before
    .replace(`import ${id} from "./tasks/${name}/task.ts";\n`, "")
    .replace(`  "${name}": ${id},\n`, "");
  // 先拿掉註冊再刪資料夾：index.ts 一改，網頁伺服器就會重啟，那時資料夾已經沒人引用
  writeFileSync(INDEX, after);
  rmSync(dir, { recursive: true, force: true });
}
