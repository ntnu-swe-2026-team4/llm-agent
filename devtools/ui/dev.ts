// bun llm ui 的守門程式：啟動網頁伺服器，程式檔（.ts）或 .env 一改就重新啟動它
//   不用 bun --watch：它在某些套件載入之後，檔案變動時不會正常重啟（實測會卡住或直接結束）
//   伺服器因為程式錯誤停掉時，等下一次存檔再試
//   這個檔案不 import 任務和框架，所以任務程式寫壞了它也不會跟著掛
import { watch } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SERVER = join(import.meta.dir, "server.ts");
const IGNORE = /(^|[\\/])(node_modules|\.pi|\.promptfoo|\.git)([\\/]|$)/;

let proc: ReturnType<typeof Bun.spawn> | null = null;
let restarting = false;

function start() {
  const me = Bun.spawn([process.execPath, SERVER], { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] });
  proc = me;
  me.exited.then(code => {
    if (proc === me && !restarting && code !== 0) {
      console.log("\n  ⚠ 網頁伺服器停止了（錯誤在上面）。修好程式存檔後會自動重新啟動。\n");
    }
  });
}

let timer: ReturnType<typeof setTimeout> | undefined;
watch(ROOT, { recursive: true }, (_event, name) => {
  const file = name ? String(name) : "";
  if (!file || IGNORE.test(file) || !(file.endsWith(".ts") || file === ".env")) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    restarting = true;
    if (proc) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    restarting = false;
    console.log(`\n  ↻ ${file} 改了，重新啟動網頁伺服器`);
    start();
  }, 200);
});

start();
