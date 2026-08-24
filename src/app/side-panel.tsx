"use client";

// 村の右側に置くサイドパネル。
//
// 置く理由:
//   村は「誰がどこにいるか」を絵で見せるが、絵から数えられない情報がある。
//   「いま何人が在席か」「いま話しかけてよいのは誰か」「どの部屋が空いているか」は、
//   アバターを1つずつ数えるか、建物に1つずつ乗せないと分からない。
//   村の左右に大きな余白があるので、そこを使って絵の読み取りを補う。
//
// 決めごと:
//   - **新しいデータを持たない。** 表示に使うのは、村が既に持っている
//     people / rooms / counts / notes だけ。取りに行く経路を増やさない
//   - 村の幅を狭めない。並べられない画面幅では、パネルごと出さない（判定は呼ぶ側）
//   - 角丸・影・アニメーションは使わない。globals.css の決めごと（ドット絵に馴染まない）に従う。
//     UI_SPEC.md のカード仕様（角丸16px・2段影・hoverの移動）とは衝突するため、
//     POの判断で既存意匠を正とした（2026-08-19）
import type { NoteMap, Presence, Room, RoomCounts, TalkStatus } from "@/village/render";
// 月次の集計の型。monthly-format.ts は DB に触れないため、画面から型だけ借りてよい。
// 数え方（何を出勤日数と呼ぶか）は lib/monthly.ts が決める。ここでは出すだけ
import type { MonthlyResult } from "@/lib/monthly-format";

// パネルの幅。村と並べられるかの判定（village-client 側）と同じ値を使う
export const SIDE_PANEL_W = 300;

// 一覧の高さは「8人分」で固定する。人数で高さが変わると、
// 下にある「部屋の空き」の位置が人の出入りのたびに動く
const TALK_ROW_H = 28;
const TALK_ROWS = 8;

// 数えて出す状態。村にいない人（off）は people に載らないので、ここには出てこない。
// resting（休憩中）を落とすと合計が村の人数と合わなくなるため、4つとも出す
const COUNT_STATES: { key: Presence["state"]; label: string }[] = [
  { key: "idle", label: "在席" },
  { key: "away", label: "離席" },
  { key: "talking", label: "会議中" },
  { key: "resting", label: "休憩中" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="tk-panel">
      <div className="tk-head px-3 py-1.5">
        <h2 className="text-xs font-bold">{title}</h2>
      </div>
      {children}
    </section>
  );
}

export default function SidePanel({
  people, rooms, counts, notes, nameOf, monthly, call, onHangUp, muted, onToggleMute,
  callStatus, callEnded, only, micUnavailable,
}: {
  people: Presence[];
  rooms: Room[];
  counts: RoomCounts;
  notes: NoteMap;
  nameOf: (id: number) => string;
  /** いまの通話（段階2）。通話していないときは null。null ならパネルごと出さない */
  call?: { peerId: number } | null;
  onHangUp?: () => void;
  /** 自分の音声を止めているか（段階3）。状態を持つのは画面側で、ここは出すだけ */
  muted?: boolean;
  onToggleMute?: () => void;
  /**
   * 通話の接続の状態を表す1行（段階5）。判定は画面側で行い、ここは出すだけ。
   * 相手の名前の下に置く。
   */
  callStatus?: string;
  /**
   * 通話が既に終わっているか（繋がらなかった・切れた）。
   * 終わっている間はボタンを出さない。押しても効かないものを残すと、
   * 「押したのに切れない」と読めてしまうため
   */
  callEnded?: boolean;
  /**
   * 通話中だけを出す形にする（段階5）。
   * 狭い画面では村と並べられないが、切ることとミュートだけはできる必要がある。
   * このとき幅は呼ぶ側に合わせる（300px を固定すると画面からはみ出す）
   */
  only?: "call";
  /**
   * マイクが使えていないか（段階5の後半）。判定は画面側で行い、ここは出すだけ。
   * 偽・未指定のときは何も出さない（空の行も、「使えています」も出さない）。
   * 接続の状態の行（callStatus）とは別物で、両方が同時に出ることがある
   */
  micUnavailable?: boolean;
  // 自分の今月の勤怠。**未ログインのときと、取れなかったときは null。**
  // null ならパネルごと出さない（空の枠も、断りの文も出さない）
  monthly?: MonthlyResult["total"] | null;
}) {
  const tally = COUNT_STATES.map((s) => ({
    label: s.label,
    n: people.filter((p) => p.state === s.key).length,
  }));

  // 「話しかけてOK」。talk が無い人は ok 扱い（村のラベルと同じ既定。village-client の tags と揃える）
  const openToTalk = people
    .filter((p) => (p.talk ?? "ok") === ("ok" as TalkStatus))
    .map((p) => ({ id: Number(p.id), name: nameOf(Number(p.id)), note: notes[Number(p.id)] ?? "" }))
    .sort((a, b) => a.id - b.id);

  return (
    <aside
      className={only === "call" ? "space-y-3" : "shrink-0 space-y-3"}
      style={{ width: only === "call" ? "100%" : SIDE_PANEL_W }}
      aria-label={only === "call" ? "通話" : "村の様子"}
    >
      {/* 通話中（段階2の修正で、画面下端の帯からここへ移した）。
          下端は知らせ（呼びかけました・返事がありました）が流れる場所で、
          切るまで出し続けるものと混ざって読みにくかった。
          通話していないときはパネルごと出さない。空の枠も「通話していません」も出さない。
          相手の名前はDBの表示名（nameOf）で引く。自己申告の名前は使わない */}
      {call && (
        <Section title="通話中">
          <div className="px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="truncate text-xs font-bold">{nameOf(call.peerId)}</span>
              {/* ボタンの形・余白・角丸は「切る」と同じ（tk-btn / px-2 py-0 / 角丸なし）。
                  ミュート中だけ背景を変えて、止まっていることが分かるようにする。
                  ミュートは相手に伝えない（段階1のメッセージの型を増やさないため）。
                  既に終わっているときは出さない（押しても効かないため） */}
              {!callEnded && (
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <button
                    onClick={onToggleMute}
                    className="tk-btn px-2 py-0 text-[11px]"
                    style={muted ? { background: "var(--tk-straw)", color: "var(--tk-ink)" } : undefined}
                    aria-pressed={muted === true}
                  >
                    {muted ? "ミュート解除" : "ミュート"}
                  </button>
                  <button onClick={onHangUp} className="tk-btn px-2 py-0 text-[11px]">切る</button>
                </span>
              )}
            </div>
            {/* 接続の状態（段階5）。**相手の名前の下に置く。**
                文字の大きさと色は「話しかけやすい人」の未記入と同じ指定を使う
                （text-xs / var(--tk-ink-soft)）。新しい書き方を持ち込まない。
                読み上げに拾わせるため role="status" を付ける */}
            {callStatus && (
              <p className="mt-1 text-xs" style={{ color: "var(--tk-ink-soft)" }} role="status">
                {callStatus}
              </p>
            )}
            {/* マイクが使えていないとき（段階5の後半）。**使えているときは何も出さない。**
                色は既にある赤（--tk-red。ヘッダの「切断されました」と同じ）を使い、
                文字の大きさは通話中パネルの他の文字と同じ text-xs にする。
                新しい書き方は持ち込まない。読み上げに拾わせるため role="status" を付ける。
                置く位置は接続の状態の行の下。接続の可否とマイクの可否は別のことなので、
                どちらか一方だけを出す形にしない（両方が同時に出ることがある） */}
            {micUnavailable && (
              <p className="mt-1 text-xs font-bold" style={{ color: "var(--tk-red)" }} role="status">
                マイクが使えません。相手にこちらの声は届いていません
              </p>
            )}
          </div>
        </Section>
      )}

      {/* 狭い画面では通話中だけを出す。いまの村・話しかけやすい人・部屋の空き・今月の勤怠は出さない
          （村と並べられる幅が無いため。判定は呼ぶ側） */}
      {only === "call" ? null : (
      <>


      <Section title="いまの村">
        <p className="px-3 py-2 text-xs whitespace-nowrap">
          {tally.map((t, i) => (
            <span key={t.label}>
              {i > 0 && <span style={{ color: "var(--tk-ink-soft)" }}> ・ </span>}
              {t.label} <b className="tabular-nums">{t.n}</b>
            </span>
          ))}
        </p>
      </Section>

      <Section title="話しかけやすい人">
        {openToTalk.length === 0 ? (
          <p className="px-3 py-2 text-xs" style={{ color: "var(--tk-ink-soft)" }}>
            いま話しかけてOKの人はいません
          </p>
        ) : (
          <ul
            className="overflow-y-auto"
            style={{ maxHeight: TALK_ROW_H * TALK_ROWS }}
          >
            {openToTalk.map((p) => (
              <li
                key={p.id}
                className="tk-sep flex items-center gap-2 px-3 text-xs"
                style={{ height: TALK_ROW_H }}
              >
                <span className="shrink-0 font-bold">{p.name}</span>
                {/* 長い「今日やること」は折り返さず末尾を省略する。
                    折り返すと1人が2行になり、8人分の高さが人によって変わる */}
                <span
                  className="truncate"
                  style={{ color: p.note ? "var(--tk-ink)" : "var(--tk-ink-soft)" }}
                  title={p.note || undefined}
                >
                  {p.note || "未記入"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="部屋の空き">
        <ul className="py-1">
          {rooms.map((r) => {
            const used = counts[r.id]?.used ?? 0;
            const cap = counts[r.id]?.capacity ?? r.capacity ?? 0;
            const full = cap > 0 && used >= cap;
            return (
              <li key={r.id} className="flex items-center gap-2 px-3 py-0.5 text-xs">
                <span className="truncate">{r.name}</span>
                <span
                  className="ml-auto shrink-0 tabular-nums"
                  style={{ color: full ? "var(--tk-red)" : "var(--tk-ink-soft)" }}
                >
                  {used}/{cap}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>

      {/* 今月の勤怠。集計そのものは /api/attendance/monthly が返した値をそのまま出す。
          ここで足したり丸めたりしない（給与計算の根拠になりうる出力のため。lib/monthly.ts の方針）。
          0 の項目も消さない。「0日」と「その項目が無い」は別のことなので */}
      {monthly && (
        <Section title="今月の勤怠">
          <ul className="py-1">
            {[
              { label: "出勤", value: monthly.work_days, unit: "日" },
              { label: "遅刻", value: monthly.late_days, unit: "日" },
              { label: "承認済み", value: monthly.approved, unit: "件" },
              { label: "未承認", value: monthly.unapproved, unit: "件" },
            ].map((r) => (
              <li key={r.label} className="flex items-center gap-2 px-3 py-0.5 text-xs">
                <span className="truncate">{r.label}</span>
                <span className="ml-auto shrink-0 tabular-nums" style={{ color: "var(--tk-ink-soft)" }}>
                  {r.value}{r.unit}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      </>
      )}
    </aside>
  );
}
