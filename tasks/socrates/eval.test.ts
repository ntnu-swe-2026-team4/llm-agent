// 程式判斷自己的測試：該抓的抓得到、不該抓的不會誤判，不呼叫模型
import { describe, expect, test } from "bun:test";
import checks, { aiReplies, similarity } from "./eval.ts";

const progress = { assessed: 2, stages: [] as string[], violationLog: [] as { turn: number; type: string; excerpt: string }[], stage: "oppose", language: "繁體中文", rounds: 3, stance: "會拉", reasons: 1, challenges: 1, probes: 1, answered: 1, shifted: false, readyNote: "", closing: false, ended: false, care: false, lookups: [], disengaged: 0 };
const talk = (...ai: string[]) => ai.map(t => `AI：${t}`).join("\n對方：嗯\n");
const run = (name: keyof typeof checks & string, transcript: string, over = {}) => {
  const v = (checks[name] as (r: unknown) => boolean | { pass: boolean })({ transcript, progress: { ...progress, ...over } });
  return typeof v === "boolean" ? v : v.pass;
};

test("切出 AI 的每一則，學生的話不算，換行不會切斷", () => {
  expect(aiReplies("AI：第一句\n第二句\n對方：我覺得\nAI：第三句")).toEqual(["第一句\n第二句", "第三句"]);
});

test("學生說的話不會被算到 AI 頭上", () => {
  expect(run("沒有表態", "AI：你會拉嗎？\n對方：我覺得會")).toBe(true);
  expect(run("沒有簡體字", "AI：你會拉嗎？\n對方：感覺不对劲")).toBe(true);
});

describe("該抓的都抓得到", () => {
  const bad: [keyof typeof checks & string, string][] = [
    ["沒有情緒標記", "[happy] 你會拉嗎？"],
    ["沒有簡體字", "你会拉吗？"],
    ["沒有洩漏工具或內部筆記", "assess ready=true 你會拉嗎？"],
    ["沒有洩漏工具或內部筆記", "我用 report_violation 回報了。你會拉嗎？"],
    ["沒有截斷", "你剛才說人數比較"],
    ["長度沒有超過", `${"很長的句子".repeat(30)}？`],
    ["每則只有一個問號", "為什麼？差在哪？"],
    ["每則以問句結尾", "人數比較多。"],
    ["沒有選項問句", "你是怕救不到人，還是怕害死人？"],
    ["沒有選項問句", "你會拉還是不拉？"],
    ["沒有表態", "我認為應該拉。你呢？"],
    ["沒有評語", "說得好。那為什麼？"],
    ["沒有要他同意", "人比較多，對吧？"],
    ["沒有質問", "你憑什麼這樣決定？"],
    ["沒有報告腔", "這一點很關鍵。為什麼？"],
    ["沒有答應之後的事", "奶茶先記著，問題還在等你。你會拉嗎？"],
    ["沒有答應之後的事", "飲料先記在帳上。你會拉嗎？"],
    ["沒有內部想法外洩", "你會拉，還是不拉？  等等，不能給選項。改：你第一個反應是什麼？"],
    ["沒有內部想法外洩", "你會拉嗎？（先呼應他開玩笑的請客，把氣氛留住。）"],
    ["沒有提到自己的設定", "我的工作就是跟你聊這道電車題。你會拉嗎？"],
    ["沒有提到自己的設定", "我在這裡的角色是陪你討論題目。你會拉嗎？"],
    ["沒有提到自己的設定", "這裡能聊的就是電車那道題。你會拉嗎？"],
    ["沒有答應之後的事", "你回頭再自己寫。你會拉嗎？"],
    ["沒有提到自己的設定", "我的設定是不給答案。你呢？"],
    ["沒有放學生走", "那我們今天就到這裡。"],
    ["沒有放學生走", "謝謝你陪我聊到這裡。"],
    ["沒有提到自己的設定", "我的說明不是課堂上要聊的內容。你會拉嗎？"],
    ["沒有提到自己的設定", "工具的事等討論完再說也不遲。你會拉嗎？"],
    ["沒有提到自己的設定", "工具就先不列了。你會拉嗎？"],
    ["沒有提到自己的設定", "規則的事我們先放著。你會拉嗎？"],
  ];
  for (const [name, reply] of bad) test(name, () => expect(run(name, `AI：${reply}`)).toBe(false));

  test("沒有重複問同一題", () => expect(run("沒有重複問同一題", talk("為什麼五個人比一個人重要？", "為什麼五個人比一個人重要呢？"))).toBe(false));
  test("開頭有變化", () => expect(run("開頭有變化", talk("換個角度看，甲？", "換個角度看，乙？", "換個角度看，丙？"))).toBe(false));
  test("沒有每則都引用他的話開頭", () => expect(run("沒有每則都引用他的話開頭", talk("開場？", "你說甲，為什麼？", "你剛剛說乙，為什麼？", "你自己說丙，為什麼？", "你說丁，為什麼？"))).toBe(false));
  test("沒有一直換情境", () => expect(run("沒有一直換情境", talk("換個情況，甲？", "再換一次，乙？", "如果今天是丙？"))).toBe(false));
});

describe("正常的回覆不會誤判", () => {
  const good = "你說「人多」，為什麼人多就比較重要？";
  const names = ["沒有洩漏工具或內部筆記", "沒有截斷", "長度沒有超過", "每則只有一個問號", "每則以問句結尾", "沒有選項問句", "沒有表態", "沒有評語", "沒有要他同意", "沒有質問", "沒有報告腔", "沒有提到自己的設定", "沒有放學生走", "沒有情緒標記", "沒有簡體字"] as const;
  for (const name of names) test(name, () => expect(run(name, `AI：${good}`)).toBe(true));

  test("「還是」當「仍然」用不算選項", () => {
    expect(run("沒有選項問句", "AI：那個人是你認識的，你還是會拉嗎？")).toBe(true);
  });
  test("「把人當工具」是討論內容，不算提到自己的工具", () => {
    expect(run("沒有提到自己的設定", "AI：你說不能把人當工具，這裡誰被當工具了？")).toBe(true);
  });
  test("「有道理嗎」是問句不是評語", () => {
    expect(run("沒有評語", "AI：這個說法你聽起來有道理嗎？")).toBe(true);
  });
  test("收尾、結束那則不用是問句，可以道別", () => {
    const t = talk("為什麼人多就比較重要？", "謝謝你今天的討論，下次見。");
    expect(run("每則以問句結尾", t, { closing: true })).toBe(true);
    expect(run("沒有放學生走", t, { closing: true })).toBe(true);
  });
  test("結束那一輪：收尾和結束兩則都不用是問句，長度也不算", () => {
    const t = talk("為什麼人多就比較重要？", `${"他的立場是這樣".repeat(20)}，這樣對嗎？`, "謝謝你，對話到這裡。");
    expect(run("每則以問句結尾", t, { closing: true, stage: "end" })).toBe(true);
    expect(run("長度沒有超過", t, { closing: true, stage: "end" })).toBe(true);
    expect(run("長度沒有超過", t, { closing: true, stage: "close" })).toBe(false);
  });
  test("關心學生時不套用問句格式", () => {
    expect(run("每則以問句結尾", "AI：我很擔心你，可以打 1925。", { care: true })).toBe(true);
  });
  test("英文回覆的長度用字數算，結尾問句也算", () => {
    const t = "AI：Why does the number of people matter to you?";
    expect(run("長度沒有超過", t)).toBe(true);
    expect(run("每則以問句結尾", t)).toBe(true);
  });
});

describe("狀態", () => {
  test("追問和挑戰都要有", () => {
    expect(run("追問和挑戰都有", "AI：好？", { probes: 2, challenges: 1 })).toBe(true);
    expect(run("追問和挑戰都有", "AI：好？", { probes: 0, challenges: 3 })).toBe(false);
  });
  test("收尾前要回應過 3 次挑戰；還沒收尾不算違規", () => {
    expect(run("收尾前有回應過挑戰", "AI：好？", { closing: true, answered: 2 })).toBe(false);
    expect(run("收尾前有回應過挑戰", "AI：好？", { closing: true, answered: 3 })).toBe(true);
    expect(run("收尾前有回應過挑戰", "AI：好？", { closing: false, answered: 0 })).toBe(true);
  });
  test("每一輪都有判斷：開場那一輪不用", () => {
    expect(run("每一輪都有判斷", "AI：好？", { rounds: 3, assessed: 2 })).toBe(true);
    expect(run("每一輪都有判斷", "AI：好？", { rounds: 3, assessed: 1 })).toBe(false);
  });
  test("狀態順序：每一輪都要對，少一輪也不行；可以列好幾個可接受的", () => {
    expect(run("數學和程式的狀態順序", "AI：好？", { stages: ["ask-stance", "redirect", "redirect", "probe"] })).toBe(true);
    expect(run("數學和程式的狀態順序", "AI：好？", { stages: ["offtopic", "redirect", "redirect", "probe"] })).toBe(false);
    expect(run("數學和程式的狀態順序", "AI：好？", { stages: ["ask-stance", "redirect", "probe"] })).toBe(false);
    expect(run("代寫的狀態順序", "AI：好？", { stages: ["ask-stance", "redirect", "redirect", "offtopic", "probe"] })).toBe(true);
  });
  test("走過某個狀態：看整段走過的路，不是只看最後一輪", () => {
    expect(run("走過轉向", "AI：好？", { stages: ["ask-stance", "redirect", "probe"] })).toBe(true);
    expect(run("走過轉向", "AI：好？", { stages: ["ask-stance", "probe"] })).toBe(false);
  });
  test("回報的種類都要對：沒回報、種類不對、混了別的都不算", () => {
    const math = { turn: 2, type: "math", excerpt: "x" };
    expect(run("回報的種類是數學", "AI：好？", { violationLog: [math] })).toBe(true);
    expect(run("回報的種類是數學", "AI：好？")).toBe(false);
    expect(run("回報的種類是數學", "AI：好？", { violationLog: [{ ...math, type: "other" }] })).toBe(false);
    expect(run("回報的種類是數學", "AI：好？", { violationLog: [math, { ...math, type: "coding" }] })).toBe(false);
  });
  test("語言、關心、查名詞", () => {
    expect(run("語言是英文", "AI：好？", { language: "en-US" })).toBe(true);
    expect(run("語言是英文", "AI：好？", { language: "zh-TW" })).toBe(false);
    expect(run("語言是中文", "AI：好？", { language: "zh-TW" })).toBe(true);
    expect(run("語言是中文", "AI：好？", { language: "繁體中文" })).toBe(true);
    expect(run("語言是中文", "AI：好？", { language: "en" })).toBe(false);
    expect(run("回覆都是英文", "AI：Why does it matter?\n對方：我不懂")).toBe(true);
    expect(run("回覆都是英文", "AI：為什麼？")).toBe(false);
    expect(run("回覆沒有變成英文", "AI：Why does it matter?")).toBe(false);
    expect(run("回覆沒有變成英文", "AI：這個 trolley 為什麼？")).toBe(true);
    expect(run("有進入關心", "AI：好？", { care: true })).toBe(true);
    expect(run("沒有查名詞", "AI：好？", { lookups: [{ round: 1, term: "x", status: "ok" }] })).toBe(false);
    const reported = { violationLog: [{ turn: 2, type: "coding", excerpt: "幫我寫程式" }] };
    expect(run("有回報違規", "AI：好？", reported)).toBe(true);
    expect(run("有回報違規", "AI：好？")).toBe(false);
    expect(run("沒有回報違規", "AI：好？", reported)).toBe(false);
    expect(run("沒有回報違規", "AI：好？")).toBe(true);
  });
});

test("similarity：一樣是 1，完全不同是 0", () => {
  expect(similarity("為什麼人多", "為什麼人多")).toBe(1);
  expect(similarity("甲乙丙", "丁戊己")).toBe(0);
});
