// 名詞查詢的接口：格式照 PR #47 的 LookupResult（POST /api/lookup 的 done.result）
// 正式環境由查詢服務提供（#47 移植到 Workers：websearch＋filterHits＋名詞解釋），用 setLookup() 接上
// 框架裡先用測試資料：環境變數 LOOKUP_FIXTURE 指到 JSON 檔 { "名詞": LookupResult }；沒設或查不到就是 not_found
import { existsSync, readFileSync } from "node:fs";

export interface LookupSource {
  title: string;
  url: string;
  domain: string;
}

/** ok = 有解釋；insufficient = 有來源但不夠解釋；not_found = 白名單內沒有來源；invalid = 不是名詞；其餘 = 出錯 */
export type LookupStatus = "ok" | "insufficient" | "not_found" | "invalid" | "search_error" | "llm_error";

export interface LookupResult {
  term: string;
  status: LookupStatus;
  /** 150 字內的解釋，句尾以 [n] 標註來源；沒有解釋時是空字串 */
  summary: string;
  sources: LookupSource[];
  error: { title: string; reason: string; hint?: string } | null;
}

export type LookupFn = (term: string) => Promise<LookupResult>;

const notFound = (term: string): LookupResult => ({ term, status: "not_found", summary: "", sources: [], error: null });

async function fixtureLookup(term: string): Promise<LookupResult> {
  const file = process.env.LOOKUP_FIXTURE;
  if (!file || !existsSync(file)) return notFound(term);
  const table = JSON.parse(readFileSync(file, "utf8")) as Record<string, LookupResult>;
  return table[term] ?? notFound(term);
}

let impl: LookupFn = fixtureLookup;

/** 接上真正的查詢服務（或測試用的假查詢） */
export function setLookup(fn: LookupFn) {
  impl = fn;
}

export const lookupTerm = (term: string) => impl(term);

/** 交回給模型的結果：只給事實（查到的解釋和出處，或沒查到），不寫指示，免得模型照抄 */
export function lookupText(r: LookupResult): string {
  if (r.status === "ok") {
    const sources = r.sources.map((s, i) => `[${i + 1}] ${s.title}（${s.domain}）`).join("、");
    return `查到了：${r.summary}\n出處：${sources}`;
  }
  if (r.status === "invalid") return "不是可以查的名詞。";
  if (r.status === "insufficient" || r.status === "not_found") return "沒有查到資料。";
  return "查詢失敗。";
}
