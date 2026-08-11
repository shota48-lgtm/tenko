"use client";

// 村の画面。
//
// 設計方針（崩さないこと）:
//   - 在席状態と「話しかけてよいか」は WebSocket のみ。DBには保存しない
//   - 「今日やること」は HTTP + DB。他人にも見えるため、入力の検証はサーバー側で行う
//   - 投稿は HTTP。ここでは扱わない（建物を押すとチャット画面へ移る）
//   - 位置は状態が決める。ドラッグや矢印キーによる自由移動は実装しない
//   - 自動で変えてよいのは「離席」への切り替えだけ。人がいることを機械が主張しない
//
// 画面の作り（Phase 4.6 でPOの実機確認を受けて作り直した）:
//   - 村では吹き出しを3件まで。全員分は右の一覧で見る
//   - 開発用の切り替え（見た目のA/B/C）は ?debug=1 のときだけ出す
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ACTIVE_VARIANT, VARIANTS, sheet } from "@/sprites";
import {
  drawVillage, drawGround, drawNoteMarks, bubbleLayoutFor, hitBuilding, VILLAGE_W, VILLAGE_H,
  type Presence, type Room, type NoteMap, type TalkStatus,
} from "@/village/render";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";
const SCALE = 2;
const STATES: Presence["state"][] = ["idle", "away", "talking", "resting"];
const STATE_LABEL: Record<Presence["state"], string> = {
  idle: "在席", away: "離席", talking: "会話中", resting: "休憩中",
};
const TALKS: TalkStatus[] = ["ok", "later", "focus"];
const TALK_LABEL: Record<TalkStatus, string> = {
  ok: "話しかけてOK", later: "後でならOK", focus: "集中中",
};
// 自動離席までの時間。仮説であり、実運用で調整する前提の値
const IDLE_MINUTES = Number(process.env.NEXT_PUBLIC_TENKO_IDLE_MINUTES ?? 10);
const NOTE_MAX = 80;

type User = { id: number; displayName: string };

// 認証は未実装。利用者は暫定的に固定値で扱う
function devUser() {
  if (typeof window === "undefined") return { id: 1, name: "利用者1", colorIndex: 1 };
  const q = new URLSearchParams(window.location.search);
  const id = Number(q.get("me") ?? 1);
  return { id, name: q.get("name") ?? "利用者" + id, colorIndex: ((id - 1) % 4) + 1 };
}
function isDebug() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("debug") === "1";
}

// 押せるものは押せる見た目にする。選択中は反転させて一目で分かるようにする
const segBase =
  "px-2.5 py-1 text-xs border border-stone-400 -ml-px first:ml-0 transition-colors " +
  "focus:outline-none focus:ring-2 focus:ring-amber-500/50";
const segOn = "bg-stone-800 text-stone-50 border-stone-800";
const segOff = "bg-stone-50 text-stone-700 hover:bg-stone-200 active:bg-stone-300";

export default function VillagePage() {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [variant, setVariant] = useState<"a" | "b" | "c">(ACTIVE_VARIANT);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [people, setPeople] = useState<Presence[]>([]);
  const [notes, setNotes] = useState<NoteMap>({});
  const [conn, setConn] = useState<"接続中" | "切断" | "再接続中">("再接続中");
  const [myState, setMyState] = useState<Presence["state"]>("idle");
  const [talk, setTalk] = useState<TalkStatus>("ok");
  const [stale, setStale] = useState(false);
  const [noteInput, setNoteInput] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteSaved, setNoteSaved] = useState(false);
  const [autoAway, setAutoAway] = useState(false);
  const [me, setMe] = useState({ id: 1, name: "利用者1", colorIndex: 1 });
  const [debug, setDebug] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const userRef = useRef(me);
  const myStateRef = useRef<Presence["state"]>("idle");
  const talkRef = useRef<TalkStatus>("ok");
  const lastActiveRef = useRef<number>(0);

  useEffect(() => { myStateRef.current = myState; }, [myState]);
  useEffect(() => { talkRef.current = talk; }, [talk]);
  useEffect(() => { userRef.current = me; }, [me]);

  const announce = useCallback((state: Presence["state"], talkStatus: TalkStatus) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({
      type: "presence.set", user: userRef.current, state, roomId: null, talk: talkStatus,
    }));
    return true;
  }, []);

  const loadNotes = useCallback(async () => {
    try {
      const res = await fetch("/api/notes");
      if (!res.ok) return;
      const d = (await res.json()) as { notes: { user_id: number; body: string }[] };
      const map: NoteMap = {};
      for (const n of d.notes) map[Number(n.user_id)] = n.body;
      setNotes(map);
    } catch { /* 取れなくても村は描く */ }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      const u = devUser();
      setMe(u);
      userRef.current = u;
      setDebug(isDebug());
      void fetch("/api/rooms").then((r) => r.json()).then((d) => setRooms(d.rooms ?? [])).catch(() => {});
      void fetch("/api/users").then((r) => r.json()).then((d) => setUsers(d.users ?? [])).catch(() => {});
      void loadNotes();
      void fetch("/api/notes?user=" + u.id).then((r) => r.json())
        .then((d) => setNoteInput(d.note?.body ?? "")).catch(() => {});
    }, 0);
    return () => clearTimeout(t);
  }, [loadNotes]);

  // WebSocket。在席と「話しかけてよいか」を配る
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = 1000;

    const connect = () => {
      setConn("再接続中");
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => {
        delay = 1000;
        setConn("接続中");
        setStale(false);
        announce(myStateRef.current, talkRef.current);
        ws.send(JSON.stringify({ type: "presence.sync" }));
      };
      ws.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data as string);
          if (d.type === "presence.list") {
            // 同じ利用者が複数の端末から接続していても、村では1人として扱う。
            // サーバー側でも畳んでいるが、古いサーバーに繋いだ場合に
            // 同じ利用者が2人描かれ、React の key が重複する（実測で発見）ため、ここでも畳む
            const byId = new Map<number, Presence>();
            for (const p of (d.users ?? []) as Presence[]) byId.set(Number(p.id), { ...p, id: Number(p.id) });
            setPeople(Array.from(byId.values()));
          }
        } catch { /* 解釈できない通知は捨てる */ }
      };
      ws.onclose = () => {
        if (closed) return;
        setConn("切断");
        setStale(true);
        timer = setTimeout(() => { delay = Math.min(delay * 2, 5000); connect(); }, delay);
      };
      ws.onerror = () => { /* close が続けて呼ばれる */ };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [announce]);

  // 自動離席。away にするだけで、idle へは自動で戻さない
  useEffect(() => {
    lastActiveRef.current = Date.now();
    const touch = () => { lastActiveRef.current = Date.now(); };
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "wheel", "touchstart"];
    for (const ev of events) window.addEventListener(ev, touch, { passive: true });
    const onVisible = () => { if (document.visibilityState === "visible") touch(); };
    document.addEventListener("visibilitychange", onVisible);

    const timer = setInterval(() => {
      if (myStateRef.current === "away") return;
      if (Date.now() - lastActiveRef.current >= IDLE_MINUTES * 60_000) {
        setAutoAway(true);
        setMyState("away");
        announce("away", talkRef.current);
      }
    }, 15_000);

    return () => {
      for (const ev of events) window.removeEventListener(ev, touch);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [announce]);

  useEffect(() => {
    const t = setInterval(() => { void loadNotes(); }, 30_000);
    return () => clearInterval(t);
  }, [loadNotes]);

  const layout = useMemo(() => bubbleLayoutFor(rooms, people, notes), [rooms, people, notes]);

  // 地面は変わらないので、一度だけ別のキャンバスに描いて使い回す。
  // 毎回描き直すと1ドットずつ約27万回の描画になり、人の出入りのたびに画面が固まる（実機で確認）
  const ground = useMemo(() => {
    if (typeof document === "undefined") return null;
    const off = document.createElement("canvas");
    off.width = VILLAGE_W;
    off.height = VILLAGE_H;
    const octx = off.getContext("2d");
    if (!octx) return null;
    drawGround(octx, sheet(variant));
    return off;
  }, [variant]);

  // 変わるものだけを描く
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, VILLAGE_W, VILLAGE_H);
    const bg = ground;
    if (bg) ctx.drawImage(bg, 0, 0);
    drawVillage(ctx, sheet(variant), rooms, people, !bg);
    drawNoteMarks(ctx, sheet(variant), layout);
  }, [rooms, people, variant, layout, ground]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const x = (e.clientX - rect.left) / SCALE;
    const y = (e.clientY - rect.top) / SCALE;
    const room = hitBuilding(rooms, x, y);
    if (room) router.push("/?room=" + room.id);
  };

  const changeState = useCallback((s: Presence["state"]) => {
    setAutoAway(false);
    lastActiveRef.current = Date.now();
    setMyState(s);
    announce(s, talkRef.current);
  }, [announce]);

  const changeTalk = useCallback((t: TalkStatus) => {
    setTalk(t);
    announce(myStateRef.current, t);
  }, [announce]);

  const saveNote = async () => {
    setNoteError(null);
    setNoteSaved(false);
    const res = await fetch("/api/notes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: noteInput, user: me.id }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setNoteError(j.error ?? "保存できませんでした");
      return;
    }
    const j = await res.json();
    setNoteInput(j.note.body);
    setNoteSaved(true);
    await loadNotes();
  };

  const clearNote = async () => {
    await fetch("/api/notes", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: me.id }),
    });
    setNoteInput("");
    setNoteSaved(false);
    await loadNotes();
  };

  // 全員の一覧。村にいない人（退勤・未接続）も出す
  const roster = useMemo(() => {
    const byId = new Map<number, Presence>();
    for (const p of people) byId.set(Number(p.id), p);
    const order: Record<string, number> = { talking: 0, idle: 1, resting: 2, away: 3, off: 4 };
    return users
      .map((u) => {
        const p = byId.get(u.id);
        return {
          id: u.id,
          // 名前は DB の表示名を正とする。
          // presence の name は本人が名乗った値であり、認証が無い今は他人の名前を騙れる（S6）
          name: u.displayName,
          state: (p?.state ?? "off") as Presence["state"] | "off",
          talk: p?.talk,
          note: notes[u.id] ?? "",
        };
      })
      .sort((a, b) => (order[a.state] - order[b.state]) || a.id - b.id);
  }, [users, people, notes]);

  const inVillage = roster.filter((r) => r.state !== "off").length;

  return (
    <main className="min-h-screen bg-stone-100 text-stone-800">
      {/* ヘッダ。押せるもの・読むもの・入力欄を、余白と枠で分ける */}
      <header className="border-b border-stone-300 bg-stone-50">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <h1 className="text-base font-semibold tracking-wide">tenko</h1>

          <span
            className={
              "inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs " +
              (conn === "接続中"
                ? "border-emerald-700/30 bg-emerald-50 text-emerald-800"
                : "border-amber-700/30 bg-amber-50 text-amber-800")
            }
            title={stale ? "切断中のため、表示は切断前の情報です" : undefined}
          >
            <span className={"h-1.5 w-1.5 rounded-full " + (conn === "接続中" ? "bg-emerald-600" : "bg-amber-500")} />
            {conn}
            {stale && <span className="text-amber-800">（表示は切断前）</span>}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="note" className="text-xs text-stone-500">今日やること</label>
            <input
              id="note"
              value={noteInput}
              onChange={(e) => { setNoteInput(e.target.value); setNoteSaved(false); }}
              onKeyDown={(e) => { if (e.key === "Enter") void saveNote(); }}
              maxLength={200}
              placeholder="例: 見積もりの作成と、15時の打ち合わせ"
              className="w-72 rounded-sm border border-stone-400 bg-white px-2 py-1 text-xs
                         placeholder:text-stone-400 focus:border-stone-600 focus:outline-none
                         focus:ring-2 focus:ring-amber-500/40"
            />
            <span className={"text-[11px] tabular-nums " + (noteInput.length > NOTE_MAX ? "text-red-700" : "text-stone-400")}>
              {Array.from(noteInput).length}/{NOTE_MAX}
            </span>
            <button
              onClick={saveNote}
              className="rounded-sm border border-stone-800 bg-stone-800 px-3 py-1 text-xs text-stone-50
                         hover:bg-stone-700 active:bg-stone-900 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            >
              保存
            </button>
            <button
              onClick={clearNote}
              className="rounded-sm border border-stone-400 bg-stone-50 px-2 py-1 text-xs text-stone-600
                         hover:bg-stone-200 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            >
              消す
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-stone-200 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-stone-500">自分の状態</span>
            <div className="flex rounded-sm">
              {STATES.map((s) => (
                <button
                  key={s}
                  onClick={() => changeState(s)}
                  aria-pressed={s === myState}
                  className={segBase + " " + (s === myState ? segOn : segOff)}
                >
                  {STATE_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-stone-500">話しかけて</span>
            <div className="flex rounded-sm">
              {TALKS.map((t) => (
                <button
                  key={t}
                  onClick={() => changeTalk(t)}
                  aria-pressed={t === talk}
                  className={segBase + " " + (t === talk ? segOn : segOff)}
                >
                  {TALK_LABEL[t]}
                </button>
              ))}
            </div>
          </div>

          {noteError && <span className="text-xs text-red-700">{noteError}</span>}
          {noteSaved && !noteError && <span className="text-xs text-emerald-700">保存しました</span>}
          {autoAway && (
            <span className="text-xs text-amber-800">
              {IDLE_MINUTES}分操作がないため離席にしました。戻すには「在席」を押してください
            </span>
          )}
        </div>

        {debug && (
          <div className="flex items-center gap-2 border-t border-stone-200 bg-stone-100 px-4 py-1.5">
            <span className="text-[11px] text-stone-500">開発用（?debug=1）</span>
            <div className="flex">
              {(["a", "b", "c"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setVariant(k)}
                  aria-pressed={k === variant}
                  className={segBase + " " + (k === variant ? segOn : segOff)}
                >
                  {k.toUpperCase()} {VARIANTS[k].meta.name}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-stone-500">部屋 {rooms.length} / 村の人 {inVillage}</span>
          </div>
        )}
      </header>

      <div className="flex items-start gap-3 p-3">
        {/* 村 */}
        {/* 村。画面に収まらない場合はページ全体ではなくこの枠の中でスクロールさせる。
            ヘッダと一覧を常に見える位置に留めるため */}
        <div className="max-h-[calc(100vh-8.5rem)] overflow-auto border border-stone-300 bg-black">
          <div className="relative" style={{ width: VILLAGE_W * SCALE, height: VILLAGE_H * SCALE }}>
            <canvas
              ref={canvasRef}
              width={VILLAGE_W}
              height={VILLAGE_H}
              onClick={onClick}
              className="block cursor-pointer"
              style={{ width: VILLAGE_W * SCALE, height: VILLAGE_H * SCALE, imageRendering: "pixelated" }}
            />
            {layout.boxes.map((b) => {
              // 人物の頭の真上に中心を合わせる。実際の枠の幅で中心を取りたいので translate(-50%) を使う。
              // ただし村の端では枠が外にはみ出して読めなくなるため、見込み幅で判定して端に寄せる。
              const half = (b.w * SCALE) / 2;
              const cx = b.tailX * SCALE;
              const right = VILLAGE_W * SCALE;
              let left = cx;
              let tx = "-50%";
              if (cx - half < 2) { left = 2; tx = "0"; }
              else if (cx + half > right - 2) { left = right - 2; tx = "-100%"; }
              return (
                // 本文は React のテキストとして入れる。HTMLとして解釈させない
                <div
                  key={b.userId}
                  className="pointer-events-none absolute border border-stone-900 bg-[#f6f1e3] px-1 py-0.5
                             text-[11px] leading-[13px] text-stone-900 shadow-[1px_1px_0_rgba(0,0,0,0.35)]"
                  style={{
                    left,
                    top: b.tailY * SCALE,
                    transform: `translate(${tx}, -100%)`,
                    maxWidth: 190,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {b.lines.join("")}
                </div>
              );
            })}
          </div>
        </div>

        {/* 全員の一覧。村は3件までなので、全員分はここで見る */}
        <aside className="w-72 shrink-0 border border-stone-300 bg-stone-50">
          <div className="flex items-baseline justify-between border-b border-stone-200 px-3 py-2">
            <h2 className="text-sm font-semibold">今日やること</h2>
            <span className="text-[11px] text-stone-500">{roster.length} 人</span>
          </div>
          <ul className="max-h-[calc(100vh-11rem)] divide-y divide-stone-200 overflow-y-auto">
            {roster.map((r) => (
              <li key={r.id} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={"h-2 w-2 shrink-0 rounded-full " + (
                    r.state === "idle" ? "bg-emerald-600"
                      : r.state === "talking" ? "bg-sky-600"
                        : r.state === "resting" ? "bg-amber-500"
                          : r.state === "away" ? "bg-stone-400" : "bg-stone-300"
                  )} />
                  <span className="truncate text-xs font-medium">{r.name}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-stone-500">
                    {r.state === "off" ? "村にいない" : STATE_LABEL[r.state]}
                  </span>
                </div>
                <p className={"mt-0.5 line-clamp-2 pl-4 text-xs " + (r.note ? "text-stone-700" : "text-stone-400")} title={r.note || undefined}>
                  {r.note || "未記入"}
                </p>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <p className="px-4 pb-3 text-xs text-stone-500">
        建物を押すと、その部屋のチャットが開きます。
      </p>
    </main>
  );
}
