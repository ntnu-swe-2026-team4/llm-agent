// socrates 自己的測試（共通檢查由 tests/extensions.test.ts 自動跑）
import { describe, expect, test } from "bun:test";
import { render, tasks } from "../../devtools/testing.ts";
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
    tool("assess").run({ ready: true, note: "只是修正整理" }, fix);
    expect(nextStage(fix, 10)).toBe("end");
    // AI 判斷還有沒談完的論點 → 回到討論，之後要再挑戰、再判斷可以才收
    const more = withReason({ ...answered(MIN_CHALLENGES), closeRounds: [9], round: 10 });
    tool("assess").run({ ready: false, note: "他提出了由誰挑那一千個，還沒談過" }, more);
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

test("語言是狀態：set_language 改了之後，prompt 照新的語言；沒呼叫就維持", async () => {
  const state = fresh();
  expect((await render(task, task.example, { state, round: 2 })).system).toContain("目前的語言：繁體中文");
  tool("set_language").run({ language: "English" }, state);
  expect((await render(task, task.example, { state, round: 3 })).system).toContain("目前的語言：English");
  expect((await render(task, task.example, { state, round: 4 })).system).toContain("（回覆的語言：English。）");
  expect(task.progress(state, 4)).toMatchObject({ language: "English" });
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
  tool("assess").run({ ready: true, note: "他只是道謝" }, thanks);
  expect(nextStage(thanks, 11)).toBe("done");

  const asks = withReason({ ...answered(MIN_CHALLENGES), closeRounds: [9], endRounds: [10], round: 11 });
  tool("assess").run({ ready: false, note: "他又問了 Tsimerman 的預測" }, asks);
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
