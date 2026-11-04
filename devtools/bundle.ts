// bun llm bundle：給 Cloudflare Workers 用的打包
//   Workers 沒有檔案系統、也不准在執行時產生程式碼，所以先把這兩樣東西打包成一個 JS 模組：
//   1. prompt 檔（shared、tasks、examples）和 providers/models.json 的內容
//   2. 每個模板（主 prompt 和片段）預先編譯好的 Handlebars 結果
//   產生的 dist/worker.ts 就是 Workers 的入口：先把打包內容交給框架，再匯出跟 index.ts 一樣的東西
//     import { llm, LLMError } from "<llm-framework>/dist/worker.ts";
import { Dotprompt } from "dotprompt";
import Handlebars from "handlebars";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { ROOT } from "../runtime/files.ts";

/** 要打包的 prompt 資料夾：shared/prompts，以及 tasks／examples 底下每個任務的 prompts/ */
function promptDirs(): string[] {
  const dirs = [join(ROOT, "shared", "prompts")];
  for (const folder of ["tasks", "examples"]) {
    const base = join(ROOT, folder);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name, "prompts");
      if (existsSync(dir)) dirs.push(dir);
    }
  }
  return dirs.filter(d => existsSync(d));
}

export function buildBundle(): { code: string; files: number; templates: number } {
  const files: Record<string, string> = {};
  const templates: [string, string][] = [];
  const dp = new Dotprompt();
  // 跟 dotprompt 執行時編譯用的選項一樣，編譯結果才會相同
  const options = {
    knownHelpers: (dp as unknown as { knownHelpers: Record<string, boolean> }).knownHelpers,
    knownHelpersOnly: true,
    noEscape: true,
  };

  for (const dir of promptDirs()) {
    for (const file of readdirSync(dir).filter(f => f.endsWith(".prompt"))) {
      const path = join(dir, file);
      const text = readFileSync(path, "utf8");
      files[relative(ROOT, path).replaceAll("\\", "/")] = text;
      // 片段整份就是模板；主 prompt 要先拿掉檔頭（dotprompt 編譯的是去掉檔頭後的內容）
      const template = basename(file).startsWith("_") ? text : dp.parse(text).template;
      templates.push([template, Handlebars.precompile(template, options) as string]);
    }
  }
  const models = join(ROOT, "providers", "models.json");
  if (existsSync(models)) files["providers/models.json"] = readFileSync(models, "utf8");

  const unique = new Map(templates);
  const code = [
    "// @ts-nocheck",
    "// bun llm bundle 產生的 Cloudflare Workers 入口，不要手改；prompt 改了要重新產生",
    'import { useBundle } from "../runtime/files.ts";',
    "",
    "useBundle({",
    `  files: ${JSON.stringify(files, null, 2).replaceAll("\n", "\n  ")},`,
    "  templates: {",
    ...[...unique].map(([template, spec]) => `    ${JSON.stringify(template)}: ${spec},`),
    "  },",
    "});",
    "",
    'export * from "../index.ts";',
    "",
  ].join("\n");
  return { code, files: Object.keys(files).length, templates: unique.size };
}

/** 寫到 out（預設 dist/worker.ts） */
export function writeBundle(out = join(ROOT, "dist", "worker.ts")) {
  const { code, files, templates } = buildBundle();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, code);
  return { out, files, templates };
}
