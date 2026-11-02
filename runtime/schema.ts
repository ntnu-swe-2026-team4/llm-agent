// 用 task.ts 的 TypeBox 格式檢查資料
// 物件沒寫 additionalProperties 的一律當成 false：多給的欄位要擋下，AI 只看得到宣告過的資料
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import type { TSchema } from "typebox";

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

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new WeakMap<TSchema, ValidateFunction>();

function describe(e: ErrorObject): string {
  const at = e.instancePath ? e.instancePath.slice(1).replaceAll("/", ".") : "";
  const p = e.params as Record<string, unknown>;
  const field = (name: unknown) => (at ? `${at}.${String(name)}` : String(name));
  switch (e.keyword) {
    case "required": return `缺少 ${field(p.missingProperty)}`;
    case "additionalProperties": return `不能有 ${field(p.additionalProperty)}（task.ts 沒有宣告這個欄位）`;
    case "enum": return `${at} 只能是：${(p.allowedValues as unknown[]).join("、")}`;
    case "type": return `${at || "整份資料"} 應該是 ${String(p.type)}`;
    default: return `${at || "整份資料"} ${e.message}`;
  }
}

/** 回傳錯誤清單；空陣列代表合格 */
export function check(schema: TSchema, value: unknown): string[] {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(strict(schema));
    compiled.set(schema, validate);
  }
  if (validate(value)) return [];
  // anyOf 的每個分支都會報錯，只留最外層那條
  const errors = validate.errors ?? [];
  const anyOf = errors.filter(e => e.keyword === "anyOf").map(e => e.instancePath);
  return [...new Set(errors
    .filter(e => e.keyword === "anyOf" || !anyOf.includes(e.instancePath))
    .map(e => e.keyword === "anyOf" ? `${e.instancePath.slice(1).replaceAll("/", ".")} 格式不對` : describe(e)))];
}
