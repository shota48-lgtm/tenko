// 発言から勤怠イベントを検出する。
//
// 設計方針（崩さないこと）:
//   - ルールベースのみ。LLM も外部APIも使わない。維持費がゼロで、根拠が説明できる
//   - 検出するのは 出社 / 退勤 / 休憩 / 遅刻 の4種類のみ
//   - 立てるのは下書きまで。確定は必ず人間が押す
//   - 迷ったら検出しない。検出漏れは手入力で済むが、誤検出は勤怠記録を汚す

export type AttendanceKind = "arrive" | "leave" | "break" | "late";

export const KIND_LABEL: Record<AttendanceKind, string> = {
  arrive: "出社",
  leave: "退勤",
  break: "休憩",
  late: "遅刻",
};

export type Detection = {
  kind: AttendanceKind;
  ruleId: string;        // どのルールに当たったか。後から「なぜ立ったか」を説明するために持つ
  matchedText: string;   // 実際に一致した部分
  eventAt: Date;         // 下書きに入る時刻
  timeSource: "explicit" | "relative" | "now" | "work_start";
};

// 始業時刻。相対表現（30分ほど遅れます）の基準に使う。
// 環境変数で持つ理由は docs に記載。既定は 09:00
export function workStart(base: Date, hhmm = process.env.TENKO_WORK_START ?? "09:00"): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  const h = m ? Number(m[1]) : 9;
  const mi = m ? Number(m[2]) : 0;
  const d = new Date(base);
  d.setHours(h, mi, 0, 0);
  return d;
}

// ---------- 除外の判定 ----------
// すべてを完璧に除くのは不可能。落とす範囲は docs に明記する

// 否定: 「遅れません」「遅刻しません」「行きません」など
// 「すみません」「申し訳ありません」は謝罪であって否定ではないため、ません の前を見て除く。
// 「していないようです」のような否定＋様態も否定として扱う。
const NEGATIVE = /(?<!すみ|すいま|かまい|申し訳あり|恐れ入り)ません|なかった|ないです|ないよう|ないみたい|ていない|ないと思|わけでは|ではない|じゃない|ずに済|しないで/;
// 過去形: 「着きました」は出社では正しいが、「昨日」「先週」などの語が付くと過去の話になる
const PAST_CONTEXT = /(昨日|一昨日|おととい|先週|先月|昨夜|ゆうべ|この前|以前|去年|昨年|先日)/;
// 未来: 当日の勤怠ではない
const FUTURE_CONTEXT = /(明日|あした|あす|明後日|来週|来月|再来週|次回|今度|来年)/;
// 他人の話: 「〜さんが」「〜くんは」など、主語が自分でない
const THIRD_PERSON = /([一-龥ぁ-んァ-ヶA-Za-z]{1,10}(さん|くん|ちゃん|部長|課長|係長|主任|専務|社長)\s*(が|は|も))/;
// 伝聞: 「〜だそうです」「〜とのことです」
// 伝聞の「そうです」は終止形に付く（遅れるそうです）。様態の「そうです」は語幹に付く（遅れそうです）。
// 前の1文字で区別する。区別しきれない語尾は諦める（報告に明記）。
const HEARSAY = /(だそう|るそう|たそう|いそうです|くそう|とのこと|らしいです|みたいです|と言っていました|だって)/;
// 疑問・依頼: 「休憩しますか」「出社しますか」
const QUESTION = /[?？]\s*$|(ますか|でしょうか|ませんか)/;

export type ExclusionReason = "negative" | "past" | "future" | "third_person" | "hearsay" | "question";

export function exclusionReason(text: string): ExclusionReason | null {
  if (NEGATIVE.test(text)) return "negative";
  if (THIRD_PERSON.test(text)) return "third_person";
  if (HEARSAY.test(text)) return "hearsay";
  if (QUESTION.test(text)) return "question";
  if (FUTURE_CONTEXT.test(text)) return "future";
  if (PAST_CONTEXT.test(text)) return "past";
  return null;
}

// ---------- 時刻の抽出 ----------
const ZEN_TO_HAN = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

// 「10時」「10時30分」「10時半」「10:30」「1030」は扱わない（誤解の元なので数字だけの表現は採らない）
// 「1時間」を「1時」と読まないよう、時 の後に 間 が続く場合は除く
const ABS_TIME = /(\d{1,2})\s*(?::|時(?!間))\s*(\d{1,2})?\s*(分|半)?/;
// 「30分ほど遅れます」「1時間遅れます」「10分遅刻します」
const REL_TIME = /(\d{1,3})\s*(分|時間)\s*(?:ほど|ぐらい|くらい|程)?\s*(?:遅れ|遅刻|遅く)/;

export function extractAbsoluteTime(text: string, base: Date): Date | null {
  const t = ZEN_TO_HAN(text);
  const m = ABS_TIME.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  let mi = 0;
  if (m[3] === "半" && m[2] === undefined) mi = 30;
  else if (m[2] !== undefined) mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  const d = new Date(base);
  d.setHours(h, mi, 0, 0);
  return d;
}

export function extractRelativeMinutes(text: string): number | null {
  const t = ZEN_TO_HAN(text);
  const m = REL_TIME.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const min = m[2] === "時間" ? n * 60 : n;
  if (min <= 0 || min > 12 * 60) return null;
  return min;
}

// ---------- ルール ----------
// strength: 明示的な宣言ほど強い。挨拶は弱い。
//   3 = その行為を宣言している / 2 = 状況の説明 / 1 = 挨拶（他の意味にも取れる）
type Rule = { id: string; kind: AttendanceKind; strength: number; re: RegExp };

export const RULES: Rule[] = [
  // 遅刻
  { id: "late.explicit", kind: "late", strength: 3, re: /(遅刻します|遅刻いたします|遅れて(?:出社|参加|向かい)|遅れます|遅れそう|遅くなります|遅くなりそう)/ },
  { id: "late.arrive_at", kind: "late", strength: 3, re: /(\d{1,2}|[０-９]{1,2})\s*(?::|時)\s*(?:\d{1,2}|[０-９]{1,2})?\s*(?:分|半)?\s*(?:頃|ごろ|くらい|ぐらい)?\s*(?:に|から)?\s*(?:着きます|到着します|出社します|出勤します|入ります|伺います|向かいます)/ },
  { id: "late.delay", kind: "late", strength: 2, re: /(電車|バス|新幹線|地下鉄|路線|ダイヤ)[^。]{0,10}(遅延|遅れ|止まって|運転見合わせ)/ },
  { id: "late.trouble", kind: "late", strength: 2, re: /(寝坊|渋滞に|事故で)/ },

  // 休憩
  { id: "break.explicit", kind: "break", strength: 3, re: /(休憩に?入ります|休憩します|休憩いたします|昼休憩|昼休みに?入ります|中抜けします)/ },
  { id: "break.lunch", kind: "break", strength: 3, re: /(ランチ|昼食|お昼)\s*(?:に)?\s*(?:行って|行きます|入ります|してきます|取ります)/ },
  { id: "break.away", kind: "break", strength: 2, re: /(離席します|席を外します|少し離れます)/ },

  // 退勤
  { id: "leave.explicit", kind: "leave", strength: 3, re: /(退勤します|退勤いたします|上がります|失礼します|終業します|本日は?これで)/ },
  { id: "leave.greeting", kind: "leave", strength: 1, re: /(お疲れ様でした|お疲れさまでした|おつかれさまでした|お先に失礼)/ },

  // 出社
  { id: "arrive.explicit", kind: "arrive", strength: 3, re: /(出社しました|出勤しました|始業します|業務を?開始します|着席しました|勤務開始)/ },
  { id: "arrive.arrived", kind: "arrive", strength: 2, re: /(着きました|到着しました|入りました)/ },
  { id: "arrive.greeting", kind: "arrive", strength: 1, re: /(おはようございます|おはよう|お早うございます)/ },
];

// 同じ強さで競合したときの優先順位。
// 「おはようございます、10時に着きます」は、まだ着いていないので遅刻を採る。
const PRIORITY: AttendanceKind[] = ["late", "break", "leave", "arrive"];

export function detect(text: string, now: Date = new Date()): Detection | null {
  if (!text || text.trim().length === 0) return null;
  if (exclusionReason(text)) return null;

  const hits: { rule: Rule; matched: string }[] = [];
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m) hits.push({ rule, matched: m[0] });
  }
  if (hits.length === 0) return null;

  // 強い宣言を優先し、同じ強さなら PRIORITY の順で決める。1つの発言から1件だけ立てる
  hits.sort((a, b) => {
    if (b.rule.strength !== a.rule.strength) return b.rule.strength - a.rule.strength;
    return PRIORITY.indexOf(a.rule.kind) - PRIORITY.indexOf(b.rule.kind);
  });
  const top = hits[0];

  // 時刻を決める
  let eventAt = now;
  let timeSource: Detection["timeSource"] = "now";
  const abs = extractAbsoluteTime(text, now);
  const rel = extractRelativeMinutes(text);
  if (top.rule.kind === "late") {
    if (abs) {
      // 「9時に着きます」は始業ちょうどで遅刻ではない。始業以前の到着予定は検出しない
      if (abs.getTime() <= workStart(now).getTime()) return null;
      eventAt = abs; timeSource = "explicit";
    }
    else if (rel != null) { eventAt = new Date(workStart(now).getTime() + rel * 60000); timeSource = "relative"; }
    else { eventAt = workStart(now); timeSource = "work_start"; }
  } else if (abs) {
    eventAt = abs;
    timeSource = "explicit";
  }

  return { kind: top.rule.kind, ruleId: top.rule.id, matchedText: top.matched, eventAt, timeSource };
}
