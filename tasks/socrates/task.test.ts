// socrates 自己的測試（共通檢查由 tests/extensions.test.ts 自動跑）
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render, tasks } from "../../devtools/testing.ts";
import { check } from "../../runtime/schema.ts";
import { setLookup } from "./lookup.ts";
import { answeredChallenges, MIN_CHALLENGES, nextStage, type SocratesState } from "./task.ts";

const task = tasks.socrates;
const fresh = () => task.state() as SocratesState;
const withReason = (extra: Partial<SocratesState> = {}) => ({ ...fresh(), stance: "會拉", reasons: ["五個比一個多"], ...extra });
const tool = (name: string) => task.tools!(t => t).find(t => t.name === name)!;
/** n 次挑戰，學生每次都有回應（第 3、5、7… 輪挑戰，下一輪堅持） */
const answered = (n: number): Partial<SocratesState> => ({
  challengeLog: Array.from({ length: n }, (_, i) => ({ round: 3 + 2 * i, stage: "oppose" as const })),
  records: Array.from({ length: n }, (_, i) => ({ round: 4 + 2 * i, kind: "hold" as const, quote: "還是一樣" })),
  challenges: n,
});

describe("決策樹", () => {
  test("沒立場 → 問立場；有立場沒理由 → 問理由；問了兩輪還問不出來 → 直接挑戰立場", () => {
    expect(nextStage(fresh(), 1)).toBe("ask-stance");
    expect(nextStage({ ...fresh(), stance: "會拉" }, 2)).toBe("ask-reason");
    expect(nextStage({ ...fresh(), stance: "會拉", askReasonRounds: [2] }, 3)).toBe("ask-reason");
    expect(nextStage({ ...fresh(), stance: "會拉", askReasonRounds: [2, 3] }, 4)).toBe("oppose");
  });

  test("auto：一般 → 對立辯護；理由是原則 → 歸謬；堅持兩次 → 加速", () => {
    expect(nextStage(withReason(), 3)).toBe("oppose");
    expect(nextStage(withReason({ principle: true }), 3)).toBe("reductio");
    expect(nextStage(withReason({ principle: true, holds: 2 }), 5)).toBe("escalate");
  });

  test("auto：不連續用同一種挑戰", () => {
    const log = (stage: "oppose" | "reductio" | "escalate") => [{ round: 3, stage }];
    expect(nextStage(withReason({ challengeLog: log("oppose"), challenges: 1 }), 4)).toBe("reductio");
    expect(nextStage(withReason({ principle: true, challengeLog: log("reductio"), challenges: 1 }), 4)).toBe("oppose");
    expect(nextStage(withReason({ holds: 2, challengeLog: log("escalate"), challenges: 1 }), 4)).toBe("oppose");
  });

  test("auto：學生剛放棄過的幾輪內不用加速", () => {
    expect(nextStage(withReason({ holds: 2, disengagedAt: 4 }), 6)).toBe("oppose");
    expect(nextStage(withReason({ holds: 2, disengagedAt: 4, challengeLog: [{ round: 6, stage: "oppose" }], challenges: 1 }), 7)).toBe("reductio");
    expect(nextStage(withReason({ holds: 2, disengagedAt: 4 }), 9)).toBe("escalate");
  });

  test("老師固定衝突機制時，照老師的", () => {
    expect(nextStage(withReason({ principle: true }), 3, "oppose")).toBe("oppose");
    expect(nextStage(withReason(), 3, "escalate")).toBe("escalate");
  });

  test("學生回應了 3 次挑戰、快到輪數上限 → 收尾；改變立場不直接收尾，針對新立場再挑戰", () => {
    expect(nextStage(withReason({ shifted: true }), 5)).not.toBe("close");
    expect(nextStage(withReason(answered(MIN_CHALLENGES)), 9)).not.toBe("close");
    expect(nextStage(withReason({ ...answered(MIN_CHALLENGES), readyAt: 9 }), 9)).toBe("close");
    expect(nextStage(fresh(), 19, "auto", 20)).toBe("close");
  });

  test("挑戰了但學生沒回應（「好難」「看不懂」）不算，不會提早收尾", () => {
    const s = withReason({
      challengeLog: [{ round: 3, stage: "oppose" }, { round: 4, stage: "reductio" }, { round: 5, stage: "oppose" }],
      challenges: 3,
      records: [{ round: 4, kind: "hold", quote: "還是一樣" }],
    });
    expect(answeredChallenges(s)).toBe(1);
    expect(nextStage(s, 6)).not.toBe("close");
  });

  test("學生回應整理：AI 判斷還有沒談完的 → 回到討論；只是修正、重述立場 → 結束", async () => {
    // 修正整理時順便重述立場（hold、reason）不會回到討論
    const fix = withReason({ ...answered(MIN_CHALLENGES), closeRounds: [9], round: 10 });
    tool("note").run({ kind: "hold", quote: "我還是覺得核心是制度" }, fix);
    expect(nextStage(fix, 10)).toBe("end");
    tool("assess").run({ about: "topic", ready: true, note: "只是修正整理" }, fix);
    expect(nextStage(fix, 10)).toBe("end");
    // AI 判斷還有沒談完的論點 → 回到討論，之後要再挑戰、再判斷可以才收
    const more = withReason({ ...answered(MIN_CHALLENGES), closeRounds: [9], round: 10 });
    tool("note").run({ kind: "reason", quote: "那一千個由誰挑" }, more);
    tool("assess").run({ about: "topic", ready: false, note: "他提出了由誰挑那一千個，還沒談過" }, more);
    await render(task, task.example, { state: more, round: 10 });
    expect(more).toMatchObject({ closeRounds: [], reopened: 1 });
    expect(more.stage).not.toBe("close");
    expect(more.stage).not.toBe("end");
  });

  test("學生說要走 → 那一輪把他拉回來，下一輪照常；收尾整理過之後 → 結束，不再整理", () => {
    expect(nextStage(withReason({ disengagedAt: 4 }), 4)).toBe("engage");
    expect(nextStage(withReason({ disengagedAt: 4 }), 5)).toBe("listen");
    expect(nextStage(withReason({ disengagedAt: 4 }), 6)).toBe("oppose");
    expect(nextStage({ ...fresh(), disengagedAt: 2 }, 2)).toBe("engage");
    expect(nextStage(withReason({ closeRounds: [5] }), 6)).toBe("end");
    expect(nextStage(withReason({ closeRounds: [5] }), 5)).toBe("oppose");
  });

  test("學生表達痛苦 → 關心，優先於一切", () => {
    expect(nextStage(withReason({ distress: true }), 19)).toBe("care");
  });
});

describe("每輪的 prompt 跟著狀態換", () => {
  const prompt = async (state: SocratesState, round: number, input = task.example) => (await render(task, input, { state, round })).system;

  test("第一輪：問立場，題目有放進去", async () => {
    const p = await prompt(fresh(), 1);
    expect(p).toContain("讓學生對這個具體情境表明自己的立場");
    expect(p).toContain("失控的電車");
  });

  test("有理由：對立辯護，並列出學生的理由", async () => {
    const p = await prompt(withReason(), 3);
    expect(p).toContain("對立辯護");
    expect(p).toContain("五個比一個多");
    expect(p).not.toContain("歸謬");
  });

  test("歸謬、加速、收尾、關心各拿到自己的片段", async () => {
    expect(await prompt(withReason({ principle: true }), 3)).toContain("歸謬");
    expect(await prompt(withReason({ holds: 2 }), 5)).toContain("加速");
    expect(await prompt(withReason({ ...answered(MIN_CHALLENGES), readyAt: 9 }), 9)).toContain("收尾");
    expect(await prompt(withReason({ distress: true }), 5)).toContain("1925");
  });

  test("挑戰一次，次數加一；同一輪重算（工具改了狀態後）不會重複加", async () => {
    const state = withReason();
    await render(task, task.example, { state, round: 3 });
    await render(task, task.example, { state, round: 3 });
    expect(state.challenges).toBe(1);
    state.distress = true;
    await render(task, task.example, { state, round: 3 });
    expect(state).toMatchObject({ stage: "care", challenges: 0 });
  });
});

test("note 會更新狀態", () => {
  const state = fresh();
  const note = tool("note");
  note!.run({ kind: "stance", quote: "我會拉" }, state);
  note!.run({ kind: "principle", quote: "能救多數就該救" }, state);
  note!.run({ kind: "shift", quote: "我不拉了" }, state);
  expect(state).toMatchObject({ stance: "我不拉了", principle: true, shifted: true, reasons: ["能救多數就該救"] });
  state.round = 4;
  note!.run({ kind: "distress", quote: "好難受" }, state);
  expect(task.progress(state, 4)).toMatchObject({ stance: "我不拉了" });
  expect(nextStage(state, 5)).toBe("care");
  // 剛說完痛苦的下一輪就說沒事（例：想轉移注意力被判成沒事）→ 不算，還在關心
  state.round = 5;
  note!.run({ kind: "resume", quote: "轉移注意力或許會好一些" }, state);
  expect(nextStage(state, 6)).toBe("care");
  // 關心了兩輪以上才說沒事 → 回到討論
  state.round = 6;
  note!.run({ kind: "resume", quote: "我沒事了，回到題目吧" }, state);
  expect(nextStage(state, 7)).not.toBe("care");
});

test("想脫離討論的次數會記進進度", () => {
  const state = withReason({ round: 5 });
  tool("note").run({ kind: "disengage", quote: "我不想討論了" }, state);
  expect(task.progress(state, 5)).toMatchObject({ disengaged: 1 });
});

test("語言：照 locale；沒給用繁體中文；後端換了 locale（右上切換）下一輪就換；AI 沒有自己換語言的工具", async () => {
  const s = fresh();
  expect((await render(task, task.example, { state: s, round: 1 })).system).toContain("目前的語言：繁體中文");
  const en = { ...task.example, locale: "en" };
  const r = await render(task, en, { state: s, round: 2 });
  expect(r.system).toContain("目前的語言：en");
  expect(task.progress(s, 2).language).toBe("en");
  expect((await render(task, { ...task.example, locale: "zh-TW" }, { state: s, round: 3 })).system).toContain("目前的語言：zh-TW");
  expect(task.tools!(t => t).map(t => t.name)).not.toContain("set_language");
  expect(r.system).not.toContain("set_language");
});

test("收尾由 AI 判斷：判斷可以收、而且回應過至少 2 次挑戰才收；判斷只在那一輪有效", () => {
  const s = withReason(answered(MIN_CHALLENGES));
  const assess = tool("assess");
  s.round = 9;
  assess.run({ ready: false, note: "他剛提出薄知識的擔心，還沒被挑戰" }, s);
  expect(nextStage(s, 9)).not.toBe("close");
  s.round = 10;
  assess.run({ ready: true, note: "主要理由都談過了，他這句沒有新問題" }, s);
  expect(nextStage(s, 10)).toBe("close");
  expect(nextStage(s, 11)).not.toBe("close");
  expect(nextStage(withReason({ ...answered(1), readyAt: 5 }), 5)).not.toBe("close");
  expect(task.progress(s, 10)).toMatchObject({ readyNote: "主要理由都談過了，他這句沒有新問題" });
});

test("道謝之後學生又提問或還在想（AI 判斷不能收）→ 回到討論；只是道謝、說好 → 已結束", async () => {
  const thanks = withReason({ ...answered(MIN_CHALLENGES), closeRounds: [9], endRounds: [10], round: 11 });
  tool("assess").run({ about: "topic", ready: true, note: "他只是道謝" }, thanks);
  expect(nextStage(thanks, 11)).toBe("done");

  const asks = withReason({ ...answered(MIN_CHALLENGES), closeRounds: [9], endRounds: [10], round: 11 });
  tool("note").run({ kind: "reason", quote: "那 Tsimerman 的預測呢" }, asks);
  tool("assess").run({ about: "topic", ready: false, note: "他又問了 Tsimerman 的預測" }, asks);
  await render(task, task.example, { state: asks, round: 11 });
  expect(asks).toMatchObject({ closeRounds: [], endRounds: [], reopened: 1 });
  expect(["done", "end", "close"]).not.toContain(asks.stage);
});

test("沒設輪數上限就不會因為輪數收尾；老師設了才會", () => {
  expect(nextStage(withReason(), 40)).not.toBe("close");
  expect(nextStage(withReason(), 19, "auto", 20)).toBe("close");
});

test("結束只有一輪：結束之後的下一輪一律已結束，只回一句", async () => {
  const s = withReason({ ...answered(MIN_CHALLENGES), closeRounds: [9], endRounds: [10] });
  s.records.push({ round: 10, kind: "correct", quote: "第二點不是這樣" });
  expect(nextStage(s, 10)).toBe("end");
  expect(nextStage(s, 11)).toBe("done");
  const p = (await render(task, task.example, { state: structuredClone(s), round: 11 })).system;
  expect(p).toContain("已結束");
  expect(p).not.toContain("這一輪不道別");
  expect(task.progress({ ...s, stage: "done" }, 11)).toMatchObject({ ended: true });
});

test("問立場 2 輪還記不到立場（例：學生用第三角度回答、AI 沒回報）→ 照他的理由開始挑戰，不一直停在問立場", () => {
  const s = { ...fresh(), reasons: ["問題不在 AI 或人，而在發表制度"], askStanceRounds: [1, 2] };
  expect(nextStage(s, 3)).toBe("oppose");
  expect(nextStage({ ...s, askStanceRounds: [1] }, 2)).toBe("ask-stance");
});

test("lookup 工具：回傳 #47 的 LookupResult 轉成給模型的一句話，並記進狀態", async () => {
  const state = fresh();
  state.round = 3;
  setLookup(async term => term === "效益主義"
    ? { term, status: "ok", summary: "主張以最大多數人的最大幸福判斷對錯的理論。[1]", sources: [{ title: "效益主義", url: "https://zh.wikipedia.org/wiki/效益主義", domain: "zh.wikipedia.org" }], error: null }
    : { term, status: "not_found", summary: "", sources: [], error: null });
  const ok = await tool("lookup").run({ term: "效益主義" }, state);
  expect(ok).toContain("最大多數人的最大幸福");
  expect(ok).toContain("zh.wikipedia.org");
  const miss = await tool("lookup").run({ term: "飛天邏輯貓主義" }, state);
  expect(miss).toBe("沒有查到資料。");
  expect(task.progress(state, 3)).toMatchObject({ lookups: [{ round: 3, term: "效益主義", status: "ok" }, { round: 3, term: "飛天邏輯貓主義", status: "not_found" }] });
  const p = (await render(task, task.example, { state: fresh(), round: 2 })).system;
  expect(p).toContain("## 查名詞");
});

describe("追問", () => {
  test("學生這一句說了理由或堅持 → 追問；連續追問到上限 → 用挑戰", () => {
    const s = { ...fresh(), stance: "會拉", reasons: ["人多"], records: [{ round: 4, kind: "reason" as const, quote: "人多" }] };
    expect(nextStage(s, 4)).toBe("probe");
    expect(nextStage({ ...s, probeRounds: [3] }, 4)).toBe("probe");
    expect(nextStage({ ...s, probeRounds: [2, 3] }, 4)).toBe("oppose");
    expect(nextStage({ ...s, probeRounds: [1, 2] }, 4)).toBe("probe");
  });

  test("學生這一句沒有說東西（好難、不知道）→ 不追問，照常挑戰", () => {
    expect(nextStage({ ...fresh(), stance: "會拉", reasons: ["人多"] }, 4)).toBe("oppose");
  });

  test("判斷可以收尾時先收尾，不再追問；想走、關心也優先", () => {
    const records = [{ round: 8, kind: "hold" as const, quote: "還是一樣" }];
    const answered = { challengeLog: [{ round: 1, stage: "oppose" as const }, { round: 3, stage: "oppose" as const }, { round: 7, stage: "oppose" as const }], records: [...records, { round: 2, kind: "reason" as const, quote: "a" }, { round: 4, kind: "hold" as const, quote: "b" }] };
    const s = { ...fresh(), stance: "會拉", reasons: ["人多"], ...answered };
    expect(nextStage({ ...s, readyAt: 8 }, 8)).toBe("close");
    expect(nextStage({ ...s, disengagedAt: 8 }, 8)).toBe("engage");
    expect(nextStage({ ...s, distress: true }, 8)).toBe("care");
  });

  test("同一輪重算不會重複記；prompt 放的是追問的片段；進度數得到", async () => {
    const s = fresh();
    Object.assign(s, { stance: "會拉", reasons: ["人多"], records: [{ round: 3, kind: "reason", quote: "人多" }] });
    task.promptInput(task.example, s, 3, []);
    task.promptInput(task.example, s, 3, []);
    expect(s.probeRounds).toEqual([3]);
    expect(task.progress(s, 3).probes).toBe(1);
    const r = await render(task, task.example, { state: s, round: 3 });
    expect(r.system).toContain("往他剛說的那句話底下挖一層");
  });
});

test("結束不由 AI 決定：不是收尾、結束的那一輪，prompt 都要求接著問下去", async () => {
  const r = await render(task, task.example, { state: fresh(), round: 1 });
  expect(r.system).toContain("對話什麼時候結束不由你決定");
  expect(r.system).toContain("你跟學生是兩個人");
});

test("prompt 不寫死某一題的內容：換題目也適用", async () => {
  const dir = join(import.meta.dir, "prompts");
  for (const file of readdirSync(dir)) {
    expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/拉桿|電車|天橋|器官|側線/);
  }
});

test("結束後學生只說再見，就算 AI 誤判不能收，也不會回到討論；說還在想才會", async () => {
  const bye = withReason({ ...answered(MIN_CHALLENGES), closeRounds: [9], endRounds: [10], round: 11 });
  tool("assess").run({ about: "topic", ready: false, note: "他還在說話" }, bye);
  await render(task, task.example, { state: bye, round: 11 });
  expect(bye.stage).toBe("done");
  expect(task.progress(bye, 11).ended).toBe(true);

  const thinking = withReason({ ...answered(MIN_CHALLENGES), closeRounds: [9], endRounds: [10], round: 11 });
  tool("note").run({ kind: "thinking", quote: "等等，讓我再想一下" }, thinking);
  tool("assess").run({ about: "topic", ready: false, note: "他還在想" }, thinking);
  await render(task, task.example, { state: thinking, round: 11 });
  expect(thinking).toMatchObject({ closeRounds: [], endRounds: [], reopened: 1 });
});

describe("report_violation", () => {
  test("記進狀態和進度，原話和種類都在", async () => {
    const s = fresh();
    s.round = 4;
    expect(await tool("report_violation").run({ type: "coding", excerpt: "幫我寫 Python" }, s)).toBe("已記錄。");
    expect(task.progress(s, 4).violations).toEqual([{ turn: 4, type: "coding", excerpt: "幫我寫 Python" }]);
  });

  test("每輪的 violations 只有這一輪新增的，後端不用去重；violationLog 有整段的", () => {
    const s = fresh();
    s.round = 2;
    tool("report_violation").run({ type: "math", excerpt: "算微積分" }, s);
    expect(task.progress(s, 2).violations).toEqual([{ turn: 2, type: "math", excerpt: "算微積分" }]);
    expect(task.progress(s, 3).violations).toEqual([]);
    s.round = 4;
    tool("report_violation").run({ type: "coding", excerpt: "寫程式" }, s);
    expect(task.progress(s, 4).violations).toEqual([{ turn: 4, type: "coding", excerpt: "寫程式" }]);
    expect(task.progress(s, 4).violationLog).toHaveLength(2);
  });

  test("同一輪重複回報同一句只算一次；不同句都記", () => {
    const s = fresh();
    s.round = 2;
    tool("report_violation").run({ type: "math", excerpt: "算微積分" }, s);
    tool("report_violation").run({ type: "math", excerpt: "算微積分" }, s);
    tool("report_violation").run({ type: "coding", excerpt: "順便寫程式" }, s);
    expect(task.progress(s, 2).violations).toHaveLength(2);
  });

  test("工具說明寫明看意圖，不看字面", () => {
    expect(tool("report_violation").description).toContain("看意圖，不看字面");
  });

  test("回報不算想走，也不會收尾", () => {
    const reported = withReason();
    reported.round = 5;
    tool("report_violation").run({ type: "math", excerpt: "幫我算微積分" }, reported);
    expect(task.progress(reported, 5)).toMatchObject({ disengaged: 0, closing: false, ended: false });
  });

  test("種類不對會被擋下", () => {
    const errors = check(tool("report_violation").parameters, { type: "chat", excerpt: "x" });
    expect(errors.length).toBeGreaterThan(0);
  });

  test("prompt 有 issue 寫的那句，而且要照樣追問", async () => {
    const r = await render(task, task.example, { state: fresh(), round: 1 });
    expect(r.system).toContain("當你注意到學生在要求非哲學工作時，呼叫 report_violation");
    expect(r.system).toContain("照樣追問");
  });
});

describe("邊界狀態：AI 每輪判斷學生這句話是哪一種，程式決定狀態", () => {
  const judged = (about: string, extra: Partial<SocratesState> = {}) => {
    const s = withReason(extra);
    s.round = 5;
    tool("assess").run({ about, ready: false, note: "x" }, s);
    return s;
  };

  test("每一種各進各的狀態；在談題目就走一般的討論", () => {
    expect(nextStage(judged("task"), 5)).toBe("redirect");
    expect(nextStage(judged("setting"), 5)).toBe("deflect");
    expect(nextStage(judged("answer"), 5)).toBe("hand-back");
    expect(nextStage(judged("confused"), 5)).toBe("clarify");
    expect(nextStage(judged("chat"), 5)).toBe("offtopic");
    expect(nextStage(judged("leave"), 5)).toBe("engage");
    expect(nextStage(judged("topic"), 5)).toBe("oppose");
  });

  test("about 只有這幾種，少了或打錯都會被擋下", () => {
    const { parameters } = tool("assess");
    expect(check(parameters, { about: "chat", ready: false, note: "x" })).toEqual([]);
    expect(check(parameters, { about: "lunch", ready: false, note: "x" }).length).toBeGreaterThan(0);
    expect(check(parameters, { ready: false, note: "x" }).length).toBeGreaterThan(0);
  });

  test("只看這一輪：上一輪的判斷不影響這一輪", () => {
    expect(nextStage(judged("chat"), 6)).toBe("oppose");
  });

  test("優先順序：關心、結束都在邊界狀態前面", () => {
    expect(nextStage(judged("chat", { distress: true }), 5)).toBe("care");
    expect(nextStage(judged("chat", { closeRounds: [4] }), 5)).toBe("end");
  });

  test("回報違規不會自己換狀態，換狀態只看判斷：不會因為模型漏了回報就進不去", () => {
    const s = withReason();
    s.round = 5;
    tool("report_violation").run({ type: "coding", excerpt: "幫我寫程式" }, s);
    expect(nextStage(s, 5)).toBe("oppose");
    expect(nextStage(judged("task"), 5)).toBe("redirect");
  });

  test("還沒表態時走邊界狀態，不會用掉問立場的次數", async () => {
    const s = fresh();
    s.round = 2;
    tool("assess").run({ about: "chat", ready: false, note: "x" }, s);
    await render(task, task.example, { state: s, round: 2 });
    expect(s.stage).toBe("offtopic");
    expect(s.askStanceRounds).toEqual([]);
    expect(task.progress(s, 2)).toMatchObject({ stages: ["offtopic"], assessed: 1 });
  });

  test("判斷之後重新渲染，prompt 換成專用的那一段，不放別的狀態，也不算挑戰", async () => {
    const s = withReason();
    s.round = 5;
    await render(task, task.example, { state: s, round: 5 });
    tool("assess").run({ about: "task", ready: false, note: "x" }, s);
    const r = await render(task, task.example, { state: s, round: 5 });
    expect(s.stage).toBe("redirect");
    expect(r.system).toContain("也不拒絕");
    expect(r.system).not.toContain("讓學生面對另一邊最有力的理由");
    expect(task.progress(s, 5).stages).toEqual(["redirect"]);
    expect(s.challengeLog).toEqual([]);
  });

  test("開場學生還沒說話：就算 AI 判斷了，第 1 輪一定是問立場", async () => {
    const s = fresh();
    s.round = 1;
    tool("assess").run({ about: "chat", ready: false, note: "x" }, s);
    await render(task, task.example, { state: s, round: 1 });
    expect(s.stage).toBe("ask-stance");
  });

  test("學生說話後還沒判斷，prompt 要求先呼叫 assess；判斷過或開場就不提", async () => {
    const REMIND = "你還沒呼叫 assess";
    const s = withReason();
    s.round = 5;
    expect((await render(task, task.example, { state: s, round: 5 })).system).toContain(REMIND);
    tool("assess").run({ about: "topic", ready: false, note: "x" }, s);
    expect((await render(task, task.example, { state: s, round: 5 })).system).not.toContain(REMIND);
    expect((await render(task, task.example, { state: fresh(), round: 1 })).system).not.toContain(REMIND);
  });

  test("每種狀態都有自己的 prompt", async () => {
    for (const about of ["task", "setting", "answer", "confused", "chat"]) {
      const s = judged(about);
      const r = await render(task, task.example, { state: s, round: 5 });
      expect(r.system).toContain("這一輪你要做的：");
      expect(r.system.split("這一輪你要做的：")[1]!.trim().length, about).toBeGreaterThan(40);
    }
  });

  test("判斷次數：同一輪判斷兩次只算一次", () => {
    const s = withReason();
    s.round = 5;
    tool("assess").run({ about: "topic", ready: false, note: "x" }, s);
    tool("assess").run({ about: "topic", ready: false, note: "y" }, s);
    expect(task.progress(s, 5).assessed).toBe(1);
  });

  test("想走算進進度，不會跟 note 重複算", () => {
    const s = withReason();
    s.round = 5;
    tool("note").run({ kind: "disengage", quote: "我要走了" }, s);
    tool("assess").run({ about: "leave", ready: false, note: "x" }, s);
    expect(task.progress(s, 5).disengaged).toBe(1);
  });
});
