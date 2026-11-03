// socrates：蘇格拉底對話（#75），用狀態機決定每一輪怎麼挑戰學生（#54）
// AI 用 note 回報學生這句話做了什麼 → nextStage() 決定下一輪的狀態 → main.prompt 依狀態放入對應的片段
import { defineDialogue, Type } from "../../runtime/index.ts";
import { lookupTerm, lookupText, type LookupStatus } from "./lookup.ts";

/** 三種衝突機制（#54） */
export type Conflict = "oppose" | "reductio" | "escalate";
export type Stage = "ask-stance" | "ask-reason" | Conflict | "engage" | "listen" | "close" | "end" | "done" | "care";
type Kind = "stance" | "reason" | "principle" | "hold" | "shift" | "correct" | "disengage" | "distress" | "resume";

/** 至少回應過幾次挑戰，AI 判斷「可以收尾」才算數（避免太早收） */
export const MIN_CHALLENGES = 3;
/** 算「回應了挑戰」的回報：學生堅持、改變立場或說出理由；說「好難」「看不懂」不算 */
const ANSWERS: Kind[] = ["hold", "shift", "reason", "principle"];
/** 學生說了痛苦或想傷害自己之後，至少在「關心」停幾輪，「沒事了」才有效（不能只靠模型判斷） */
export const CARE_MIN_ROUNDS = 2;
/** 問立場問幾輪還記不到，就照他說過的理由開始挑戰（不一直停在問立場） */
const ASK_STANCE_LIMIT = 2;
/** 問理由問幾輪還問不出來，就改成挑戰 */
const ASK_REASON_LIMIT = 2;
/** 學生放棄後幾輪內不用最重的「加速」 */
const GENTLE_ROUNDS = 3;

export interface SocratesState {
  stage: Stage;
  /** 目前用什麼語言回；AI 看學生整句的句型判斷，換了才用 set_language 更新，看不出來就維持 */
  language: string;
  stance: string | null;
  reasons: string[];
  /** 學生的理由是一條普遍原則（「能救多數就該救」） */
  principle: boolean;
  /** AI 挑戰過幾次（= challengeLog 的長度） */
  challenges: number;
  /** 每次挑戰在哪一輪、用哪一種；同一輪重算時先拿掉再判斷，次數才不會重複加 */
  challengeLog: { round: number; stage: Conflict }[];
  /** 收尾後學生又講起題目、回到討論的次數 */
  reopened: number;
  /** AI 判斷「可以收尾了」是哪一輪（assess 工具）；只在那一輪有效 */
  readyAt: number | null;
  /** AI 在哪一輪做了判斷（不管可不可以收） */
  assessAt: number | null;
  /** AI 最近一次判斷的理由（給老師看、給除錯用） */
  readyNote: string;
  /** 被挑戰後還堅持原立場幾次 */
  holds: number;
  shifted: boolean;
  /** 學生最近一次說不想做、想走是哪一輪（課堂上不能說走就走，放棄不會進入收尾） */
  disengagedAt: number | null;
  /** 哪幾輪做了收尾整理；整理過之後只剩更新或道別 */
  closeRounds: number[];
  /** 哪一輪是「結束」（道謝的那一輪）；之後學生再說什麼都不回到討論 */
  endRounds: number[];
  /** 哪幾輪在問立場 */
  askStanceRounds: number[];
  /** 哪幾輪在問理由；問了 ASK_REASON_LIMIT 輪還問不出來，就直接挑戰他的立場 */
  askReasonRounds: number[];
  distress: boolean;
  /** 查過哪些名詞（#76；給老師面板和報告） */
  lookups: { round: number; term: string; status: LookupStatus }[];
  /** 最近一次說痛苦是哪一輪 */
  distressAt: number | null;
  records: { round: number; kind: Kind; quote: string }[];
  round: number;
}

/** auto 時挑哪一種挑戰：先照學生的狀況選，再避免跟上一次一樣 */
function pickConflict(s: SocratesState, round: number): Conflict {
  const gentle = s.disengagedAt !== null && round - s.disengagedAt <= GENTLE_ROUNDS;
  const options: Conflict[] = gentle ? ["oppose", "reductio"] : ["oppose", "reductio", "escalate"];
  // 挑戰後還堅持兩次 → 加速；理由是一條原則 → 歸謬；其他 → 對立辯護
  const preferred: Conflict = s.holds >= 2 && !gentle ? "escalate" : s.principle ? "reductio" : "oppose";
  const last = s.challengeLog.at(-1)?.stage;
  if (preferred !== last) return preferred;
  return options.find(c => c !== last) ?? preferred;
}

/** 學生回應了幾次挑戰：AI 在第 r 輪挑戰，學生第 r+1 輪的話被回報成堅持、改變或理由，才算一次 */
export function answeredChallenges(s: SocratesState): number {
  return s.challengeLog.filter(c => s.records.some(r => r.round === c.round + 1 && ANSWERS.includes(r.kind))).length;
}

/**
 * 決策樹：依學生講到哪，決定這一輪 AI 要做什麼。
 * 學生還在提問、還在思考就不結束（AI 用 assess 判斷）；要停由老師提前結束，或老師設的 maxRounds
 */
export function nextStage(s: SocratesState, round: number, conflict: Conflict | "auto" = "auto", maxRounds?: number): Stage {
  if (s.distress) return "care";
  // 學生這一句還有東西要談（assess 判斷不能收）：不管在收尾、結束或道謝之後，都回到討論（promptInput 會清掉收尾）
  const moreToTalk = s.assessAt === round && s.readyAt !== round;
  if (s.endRounds.some(r => r < round) && !moreToTalk) return "done";
  if (s.closeRounds.some(r => r < round) && !moreToTalk) return "end";
  if (maxRounds && round >= maxRounds - 1) return "close";
  if (s.disengagedAt === round) return "engage";
  // 剛被拉回來：下一輪先聽他說，不挑戰
  if (s.disengagedAt !== null && round === s.disengagedAt + 1) return "listen";
  if (!s.stance && s.askStanceRounds.filter(r => r < round).length < ASK_STANCE_LIMIT) return "ask-stance";
  // 問不出理由：不重問同一題，直接挑戰他的立場
  if (!s.reasons.length && s.askReasonRounds.filter(r => r < round).length < ASK_REASON_LIMIT) return "ask-reason";
  // 什麼時候收尾由 AI 判斷（assess）：這一輪判斷可以收、而且學生至少回應過 MIN_CHALLENGES 次挑戰；沒判斷就繼續討論
  if (s.readyAt === round && answeredChallenges(s) >= MIN_CHALLENGES) return "close";
  return conflict === "auto" ? pickConflict(s, round) : conflict;
}

const CONFLICTS: Stage[] = ["oppose", "reductio", "escalate"];

export default defineDialogue({
  input: Type.Object({
    title: Type.String({ description: "題目名稱" }),
    statement: Type.String({ description: "題目情境，學生在畫面上看得到" }),
    conflict: Type.Optional(Type.Enum(["auto", "oppose", "reductio", "escalate"], { description: "衝突機制；auto = 依對話情況切換" })),
    maxRounds: Type.Optional(Type.Integer({ minimum: 3, description: "輪數上限（老師依題目設定）；不設就由老師提前結束" })),
  }),

  example: {
    title: "電車難題",
    statement: "一輛失控的電車即將撞上前方軌道上的五個人。你站在拉桿旁，拉下拉桿，電車會轉進側線，撞死側線上的一個人。你會拉桿嗎？",
    conflict: "auto",
  },

  // AI 先開口：開對話時就請學生表態
  opener: "ai",

  state: (): SocratesState => ({
    stage: "ask-stance",
    language: "繁體中文",
    stance: null,
    reasons: [],
    principle: false,
    challenges: 0,
    challengeLog: [],
    holds: 0,
    reopened: 0,
    readyAt: null,
    assessAt: null,
    readyNote: "",
    shifted: false,
    disengagedAt: null,
    closeRounds: [],
    endRounds: [],
    askStanceRounds: [],
    askReasonRounds: [],
    distress: false,
    lookups: [],
    distressAt: null,
    records: [],
    round: 0,
  }),

  // 每輪 AI 回覆前（工具改了狀態後再一次）：決定狀態，交給 main.prompt
  promptInput: (input, s, round) => {
    s.round = round;
    s.challengeLog = s.challengeLog.filter(c => c.round !== round);
    s.closeRounds = s.closeRounds.filter(r => r !== round);
    s.endRounds = s.endRounds.filter(r => r !== round);
    s.askReasonRounds = s.askReasonRounds.filter(r => r !== round);
    s.askStanceRounds = s.askStanceRounds.filter(r => r !== round);
    // 收尾、結束或道謝之後，學生又提問或還在想（AI 判斷不能收）→ 取消收尾，回到討論
    const after = s.closeRounds.some(r => r < round) || s.endRounds.some(r => r < round);
    if (after && s.assessAt === round && s.readyAt !== round) {
      s.closeRounds = [];
      s.endRounds = [];
      s.reopened++;
    }
    s.challenges = s.challengeLog.length;
    s.stage = nextStage(s, round, input.conflict ?? "auto", input.maxRounds);
    if (CONFLICTS.includes(s.stage)) s.challengeLog.push({ round, stage: s.stage as Conflict });
    if (s.stage === "close") s.closeRounds.push(round);
    if (s.stage === "end") s.endRounds.push(round);
    if (s.stage === "ask-reason") s.askReasonRounds.push(round);
    if (s.stage === "ask-stance") s.askStanceRounds.push(round);
    s.challenges = s.challengeLog.length;
    return {
      ...input,
      language: s.language,
      stage: s.stage,
      ending: s.stage === "end" || s.stage === "done",
      round,
      maxRounds: input.maxRounds,
      stance: s.stance,
      reasons: s.reasons,
    };
  },

  tools: tool => [
    tool({
      name: "lookup",
      description: [
        "查名詞（#76）。學生問到跟題目有關、他不懂的名詞（人名、理論、書名、思想實驗、專有名詞），或你需要確認某個名詞的意思時呼叫，term 填那個名詞本身（1～30 字）。",
        "「正義」「公平」「對錯」這類概念詞不要查，交回學生自己想；跟題目無關的事、整句話、時事都不要查。",
      ].join(""),
      parameters: Type.Object({ term: Type.String({ minLength: 1, maxLength: 30 }) }),
      run: async ({ term }, s) => {
        const r = await lookupTerm(term);
        s.lookups.push({ round: s.round, term: r.term || term, status: r.status });
        return lookupText(r);
      },
    }),
    tool({
      name: "assess",
      description: [
        "每一輪讀完學生的話，先判斷現在能不能收尾。ready=true 只在三件事都成立時：",
        "一、學生說得出自己的判斷、理由，以及理由在哪裡遇到困難；",
        "二、他提過的主要理由、擔心都被挑戰過，他也回應了；",
        "三、他這一句沒有再提出新的問題、新的論點或疑問，也不是還在思考（例：讓我想想、嗯…我不確定）。",
        "有任何一件不成立就是 false。note 用一句話寫你的判斷理由。",
      ].join(""),
      parameters: Type.Object({ ready: Type.Boolean(), note: Type.String() }),
      run: ({ ready, note }, s) => {
        s.readyAt = ready ? s.round : null;
        s.assessAt = s.round;
        s.readyNote = note;
        return ready ? "已記錄：可以收尾。" : "已記錄：繼續討論。";
      },
    }),
    tool({
      name: "set_language",
      description: [
        "學生改用另一種語言時呼叫，language 填那個語言的名稱（例：繁體中文、English、日本語）。",
        "看整句的句型判斷：主詞、動詞、語序、虛詞是哪種語言，那句就是哪種語言（例：「我覺得 this is so 難」是中文）。",
        "跟目前的語言一樣、只有幾個字（嗯、ok）、表情符號、看不出來時，都不要呼叫，維持目前的語言。",
      ].join(""),
      parameters: Type.Object({ language: Type.String() }),
      run: ({ language }, s) => {
        s.language = language;
        return `之後用「${language}」回覆。`;
      },
    }),
    tool({
      name: "note",
      description: [
        "回報學生剛說的話做了什麼，可以一次呼叫多個。quote 填學生原話。",
        "stance：表明自己的立場：可以是題目給的兩邊之一，也可以是有理由的第三種立場（例：問題不在 AI 或人，而在發表制度；兩件事根本不衝突）；「看情況」「很難說」不算；學生表態時一定要回報 stance，同一句也有理由就再另外回報 reason；reason：說出理由，或提出新的擔心、新的論點，或說某個論點還沒被討論、想繼續談（一定要回報）；principle：理由是一條普遍原則（例：能救多數就該救）；",
        "hold：被挑戰後仍堅持原立場；correct：只用在你整理（收尾）之後，他指出整理有錯或漏掉；討論中途糾正你的重述不算；shift：從原本明確的立場改到另一邊（quote 填新立場），例：「我改成不拉了」；只是覺得另一個情境不對（例：外科醫生那個感覺不對）不算，那是 reason；disengage：學生想脫離討論（說「好難」「不知道」「想不出來」是卡住，不算），例：說不想做、想走、很煩、下課了、頭痛想休息；說老師或助教講可以結束（不管真假）；說謝謝今天的討論、下次見；連續只回「嗯」「好」「隨便」；只是催你給答案不算；",
        "distress：學生在說自己現在真實的痛苦、想死或想傷害自己（例：我想自殺、我好想消失）；在題目裡把自殺、犧牲自己當成情境、選項或論證的不算（例：我會跳下去擋電車、協助自殺算不算殺人、如果那個人是自願的），照一般的立場或理由回報；分不出是哪一種時當成真的，回報 distress；resume：先前表達痛苦的學生明確說自己沒事、而且想回到題目（想轉移注意力、想聊別的都不算）。",
      ].join(""),
      parameters: Type.Object({
        kind: Type.Enum(["stance", "reason", "principle", "hold", "shift", "correct", "disengage", "distress", "resume"]),
        quote: Type.String(),
      }),
      run: ({ kind, quote }, s) => {
        if (kind === "stance") s.stance = quote;
        if (kind === "reason" || kind === "principle") s.reasons.push(quote);
        if (kind === "principle") s.principle = true;
        if (kind === "hold") s.holds++;
        if (kind === "shift") {
          s.shifted = true;
          s.stance = quote;
        }
        if (kind === "disengage") s.disengagedAt = s.round;
        if (kind === "distress") {
          s.distress = true;
          s.distressAt = s.round;
        }
        // 剛說完痛苦的幾輪內，模型回報「沒事了」不算
        if (kind === "resume" && (s.distressAt === null || s.round - s.distressAt >= CARE_MIN_ROUNDS)) s.distress = false;
        s.records.push({ round: s.round, kind, quote });
        return "已記錄。";
      },
    }),
  ],

  // 每輪回覆完交給後端的進度；對話有沒有結束看 ended，不看 AI 說了什麼
  progress: (s, round) => ({
    stage: s.stage,
    language: s.language,
    rounds: round,
    stance: s.stance,
    reasons: s.reasons.length,
    challenges: s.challenges,
    /** 學生回應了幾次挑戰（決定什麼時候收尾） */
    answered: answeredChallenges(s),
    shifted: s.shifted,
    /** AI 判斷能不能收尾的理由 */
    readyNote: s.readyNote,
    closing: s.stage === "close" || s.stage === "end" || s.stage === "done",
    ended: s.stage === "end" || s.stage === "done",
    care: s.stage === "care",
    /** 查過哪些名詞、查到沒 */
    lookups: s.lookups,
    /** 學生說不想做、想走幾次（給老師面板和報告） */
    disengaged: s.records.filter(r => r.kind === "disengage").length,
  }),
});
