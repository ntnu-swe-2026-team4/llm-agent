// 用 task.ts 的 TypeBox 格式檢查資料
// 物件沒寫 additionalProperties 的一律當成 false：多給的欄位要擋下，AI 只看得到宣告過的資料
// 用 TypeBox 的直譯式檢查（typebox/schema），不在執行時產生程式碼，Cloudflare Workers 上也能用
import type { TSchema } from "typebox";
import Schema from "typebox/schema";

/** 轉成純 JSON Schema，並把所有物件設成不准有多的欄位 */
export function strict(schema: TSchema): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v);
    if (out.type === "object" && out.additionalProperties === undefined) out.additionalProperties = false;
    return out;
  };
  return walk(schema) as Record<string, unknown>;
}

const strictCache = new WeakMap<TSchema, Record<string, unknown>>();

interface SchemaError {
  keyword: string;
  instancePath: string;
  params: Record<string, unknown>;
  message: string;
}

function describe(e: SchemaError): string[] {
  const at = e.instancePath ? e.instancePath.slice(1).replaceAll("/", ".") : "";
  const p = e.params;
  const field = (name: unknown) => (at ? `${at}.${String(name)}` : String(name));
  switch (e.keyword) {
    case "required": return (p.requiredProperties as unknown[]).map(name => `缺少 ${field(name)}`);
    case "additionalProperties": return (p.additionalProperties as unknown[]).map(name => `不能有 ${field(name)}（task.ts 沒有宣告這個欄位）`);
    case "enum": return [`${at} 只能是：${(p.allowedValues as unknown[]).join("、")}`];
    case "type": return [`${at || "整份資料"} 應該是 ${String(p.type)}`];
    // 多出來的欄位另外會報一條 schema is false，上面的 additionalProperties 已經說了
    case "boolean": return [];
    default: return [`${at || "整份資料"} ${e.message}`];
  }
}

/** 回傳錯誤清單；空陣列代表合格 */
export function check(schema: TSchema, value: unknown): string[] {
  let json = strictCache.get(schema);
  if (!json) {
    json = strict(schema);
    strictCache.set(schema, json);
  }
  const [ok, found] = Schema.Errors(json as never, value);
  if (ok) return [];
  // anyOf 的每個分支都會報錯，只留最外層那條
  const errors = found as unknown as SchemaError[];
  const anyOf = errors.filter(e => e.keyword === "anyOf").map(e => e.instancePath);
  const inside = (e: SchemaError) => anyOf.some(path => e.instancePath === path || e.instancePath.startsWith(`${path}/`));
  return [...new Set(errors
    .filter(e => e.keyword === "anyOf" || !inside(e))
    .flatMap(e => e.keyword === "anyOf" ? [`${e.instancePath.slice(1).replaceAll("/", ".")} 格式不對`] : describe(e)))];
}
