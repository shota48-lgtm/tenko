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
  people, rooms, counts, notes, nameOf,
}: {
  people: Presence[];
  rooms: Room[];
  counts: RoomCounts;
  notes: NoteMap;
  nameOf: (id: number) => string;
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
      className="shrink-0 space-y-3"
      style={{ width: SIDE_PANEL_W }}
      aria-label="村の様子"
    >
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
    </aside>
  );
}
