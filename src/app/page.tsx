"use client";

// 村の画面（tenko の入口）。
//
// 設計方針（崩さないこと）:
//   - 在席状態と「話しかけてよいか」は WebSocket のみ。DBには保存しない
//   - 「今日やること」は HTTP + DB。他人にも見えるため、入力の検証はサーバー側で行う
//   - 投稿は HTTP。ここでは扱わない（建物を押すとチャットへ移る）
//   - 位置は状態が決める。ドラッグや矢印キーによる自由移動は実装しない
//   - 自動で変えてよいのは「離席」への切り替えだけ。人がいることを機械が主張しない
//
// 画面の作り（Phase 4.7。「操作がヘッダに全部ある」形を作り直した）:
//   - 状態はアバターの足元のリングで示す（色＋線の形。色だけに頼らない）
//   - 話しかけ可否は名前の前のラベルで示す（oVice の「声掛けNG」に相当）
//   - 操作は自分のアバターを押して出すメニューに集約する。他人を押しても見るだけ
//   - ヘッダに残すのはアプリ名と接続状態だけ。移動の導線は画面下部にまとめる
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ACTIVE_VARIANT, VARIANTS, sheet } from "@/sprites";
import {
  drawVillage, drawGround, drawNoteMarks, bubbleLayoutFor, hitBuilding, hitPerson,
  VILLAGE_W, VILLAGE_H, PERSON_SIZE,
  type Presence, type Room, type NoteMap, type TalkStatus,
} from "@/village/render";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";
const SCALE = 2;
const STATES: Presence["state"][] = ["idle", "away", "talking", "resting"];
const STATE_LABEL: Record<Presence["state"], string> = {
  idle: "在席", away: "離席", talking: "会話中", resting: "休憩中",
};
// リングの色。描画側（render.ts）と揃えること
const STATE_DOT: Record<Presence["state"], string> = {
  idle: "bg-emerald-700", talking: "bg-sky-700", resting: "bg-amber-600", away: "bg-stone-400",
};
const TALKS: TalkStatus[] = ["ok", "later", "focus"];
const TALK_LABEL: Record<TalkStatus, string> = {
  ok: "話しかけてOK", later: "後でならOK", focus: "集中中",
};
// 村に出す短いラベル。ok は既定なので出さない（全員に付くと画面が埋まる）
const TALK_TAG: Record<TalkStatus, string | null> = {
  ok: null, later: "後で", focus: "集中中",
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

const menuBtn =
  "w-full px-2 py-1 text-left text-xs border border-stone-300 bg-stone-50 text-stone-700 " +
  "hover:bg-stone-200 focus:outline-none focus:ring-2 focus:ring-amber-500/50";
const menuBtnOn = "w-full px-2 py-1 text-left text-xs border border-stone-800 bg-stone-800 text-stone-50";

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
  // アバターを押して出すもの。自分なら操作、他人なら情報だけ
  const [picked, setPicked] = useState<{ id: number; x: number; y: number } | null>(null);
  const [showRoster, setShowRoster] = useState(true);

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
            // 同じ利用者が複数の端末から接続していても、村では1人として扱う
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

  // 地面は変わらないので一度だけ描いて使い回す（毎回描くと約27万回になり固まる）
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

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, VILLAGE_W, VILLAGE_H);
    if (ground) ctx.drawImage(ground, 0, 0);
    drawVillage(ctx, sheet(variant), rooms, people, !ground);
    drawNoteMarks(ctx, sheet(variant), layout);
  }, [rooms, people, variant, layout, ground]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const x = (e.clientX - rect.left) / SCALE;
    const y = (e.clientY - rect.top) / SCALE;
    // 人物が建物より手前。押した位置に人がいればそちらを優先する
    const person = hitPerson(rooms, people, x, y);
    if (person) {
      setPicked({ id: Number(person.id), x, y });
      return;
    }
    setPicked(null);
    const room = hitBuilding(rooms, x, y);
    if (room) router.push("/rooms/" + room.id);
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

  const leaveVillage = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "presence.set", user: userRef.current, state: "off" }));
    }
    setPicked(null);
  }, []);

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
          // 名前は DB の表示名を正とする。presence の name は自己申告で騙れる
          name: u.displayName,
          state: (p?.state ?? "off") as Presence["state"] | "off",
          talk: p?.talk,
          note: notes[u.id] ?? "",
        };
      })
      .sort((a, b) => (order[a.state] - order[b.state]) || a.id - b.id);
  }, [users, people, notes]);

  const nameOf = useCallback(
    (id: number) => users.find((u) => u.id === id)?.displayName ?? "利用者" + id,
    [users],
  );

  // 村に置く名前と話しかけ可否のラベル。人物の座標に合わせて重ねる
  const tags = useMemo(() => {
    return layout.spots.map((s) => ({
      id: Number(s.p.id),
      x: s.x,
      y: s.y,
      name: nameOf(Number(s.p.id)),
      talk: (s.p.talk ?? "ok") as TalkStatus,
      state: s.p.state,
      isMe: Number(s.p.id) === me.id,
    }));
  }, [layout.spots, nameOf, me.id]);

  const pickedPerson = picked ? people.find((p) => Number(p.id) === picked.id) : undefined;
  const pickedIsMe = picked?.id === me.id;
  const inVillage = roster.filter((r) => r.state !== "off").length;

  return (
    <main className="min-h-screen bg-stone-100 text-stone-800">
      {/* ヘッダはアプリ名と接続状態だけ。操作はアバターと画面下部に移した */}
      <header className="flex items-center gap-3 border-b border-stone-300 bg-stone-50 px-4 py-1.5">
        <h1 className="text-sm font-semibold tracking-wide">tenko</h1>
        <span
          className={
            "inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[11px] " +
            (conn === "接続中"
              ? "border-emerald-700/30 bg-emerald-50 text-emerald-800"
              : "border-amber-700/40 bg-amber-50 text-amber-900")
          }
        >
          <span className={"h-1.5 w-1.5 rounded-full " + (conn === "接続中" ? "bg-emerald-600" : "bg-amber-500")} />
          {conn}
          {stale && <span>（表示は切断前）</span>}
        </span>
        {debug && (
          <span className="ml-auto flex items-center gap-2 text-[11px] text-stone-500">
            開発用: 部屋 {rooms.length} / 村の人 {inVillage}
            {(["a", "b", "c"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setVariant(k)}
                disabled={k === variant}
                className={"border px-1.5 py-0.5 " + (k === variant ? "border-stone-800 bg-stone-800 text-stone-50" : "border-stone-400 bg-stone-50")}
              >
                {k.toUpperCase()} {VARIANTS[k].meta.name}
              </button>
            ))}
          </span>
        )}
      </header>

      <div className="flex items-start gap-3 p-3">
        <div className="max-h-[calc(100vh-7.5rem)] overflow-auto border border-stone-300 bg-black">
          <div className="relative" style={{ width: VILLAGE_W * SCALE, height: VILLAGE_H * SCALE }}>
            <canvas
              ref={canvasRef}
              width={VILLAGE_W}
              height={VILLAGE_H}
              onClick={onClick}
              className="block cursor-pointer"
              style={{ width: VILLAGE_W * SCALE, height: VILLAGE_H * SCALE, imageRendering: "pixelated" }}
            />

            {/* 名前と話しかけ可否。アバターのすぐ下に置く */}
            {tags.map((t) => (
              <div
                key={t.id}
                className="pointer-events-none absolute flex items-center gap-0.5 whitespace-nowrap"
                style={{
                  left: (t.x + PERSON_SIZE / 2) * SCALE,
                  // 足元のリングを隠さない位置に置く（実機で被っていたため下げた）
                  top: (t.y + PERSON_SIZE + 5) * SCALE,
                  transform: "translateX(-50%)",
                }}
              >
                {TALK_TAG[t.talk] && (
                  <span
                    className={
                      "rounded-[2px] px-1 text-[9px] leading-[13px] text-white " +
                      (t.talk === "focus" ? "bg-red-800" : "bg-amber-700")
                    }
                  >
                    {TALK_TAG[t.talk]}
                  </span>
                )}
                <span
                  className={
                    "rounded-[2px] px-1 text-[10px] leading-[12px] " +
                    (t.isMe ? "bg-stone-900 text-amber-200" : "bg-stone-900/75 text-stone-50")
                  }
                >
                  {t.name}
                </span>
              </div>
            ))}

            {/* 今日やること（上限3件） */}
            {layout.boxes.map((b) => {
              const half = (b.w * SCALE) / 2;
              const cx = b.tailX * SCALE;
              const right = VILLAGE_W * SCALE;
              let left = cx;
              let tx = "-50%";
              if (cx - half < 2) { left = 2; tx = "0"; }
              else if (cx + half > right - 2) { left = right - 2; tx = "-100%"; }
              return (
                <div
                  key={b.userId}
                  className="pointer-events-none absolute border border-stone-900 bg-[#f6f1e3] px-1 py-0.5
                             text-[11px] leading-[13px] text-stone-900 shadow-[1px_1px_0_rgba(0,0,0,0.35)]"
                  style={{
                    left, top: b.tailY * SCALE, transform: `translate(${tx}, -100%)`,
                    maxWidth: 190, whiteSpace: "pre-wrap", wordBreak: "break-word",
                  }}
                >
                  {b.lines.join("")}
                </div>
              );
            })}

            {/* アバターを押して出すもの。自分なら操作、他人なら見るだけ */}
            {picked && (
              <div
                className="absolute z-10 w-56 border border-stone-400 bg-stone-50 p-2 shadow-lg"
                style={{
                  left: Math.min(picked.x * SCALE, VILLAGE_W * SCALE - 240),
                  // 村の下半分にいる人は、メニューを上向きに出す。
                  // 下に出すと村の枠の外へ落ちて切れる（実機で確認）
                  top: picked.y * SCALE,
                  transform: picked.y > VILLAGE_H / 2 ? "translateY(-100%)" : `translateY(${PERSON_SIZE * SCALE}px)`,
                }}
              >
                <div className="mb-1.5 flex items-center gap-1.5 border-b border-stone-200 pb-1">
                  <span className={"h-2 w-2 rounded-full " + (pickedPerson ? STATE_DOT[pickedPerson.state] : "bg-stone-300")} />
                  <span className="text-xs font-semibold">{nameOf(picked.id)}</span>
                  <span className="ml-auto text-[10px] text-stone-500">
                    {pickedPerson ? STATE_LABEL[pickedPerson.state] : "村にいない"}
                  </span>
                  <button
                    onClick={() => setPicked(null)}
                    className="ml-1 border border-stone-300 px-1 text-[10px] text-stone-600 hover:bg-stone-200"
                    aria-label="閉じる"
                  >
                    ×
                  </button>
                </div>

                {pickedIsMe ? (
                  <div className="space-y-1.5">
                    <div>
                      <p className="mb-0.5 text-[10px] text-stone-500">自分の状態</p>
                      <div className="grid grid-cols-2 gap-1">
                        {STATES.map((s) => (
                          <button key={s} onClick={() => changeState(s)} className={s === myState ? menuBtnOn : menuBtn}>
                            {STATE_LABEL[s]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="mb-0.5 text-[10px] text-stone-500">話しかけて</p>
                      <div className="space-y-1">
                        {TALKS.map((t) => (
                          <button key={t} onClick={() => changeTalk(t)} className={t === talk ? menuBtnOn : menuBtn}>
                            {TALK_LABEL[t]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="mb-0.5 text-[10px] text-stone-500">
                        今日やること
                        <span className={"ml-1 " + (Array.from(noteInput).length > NOTE_MAX ? "text-red-700" : "")}>
                          {Array.from(noteInput).length}/{NOTE_MAX}
                        </span>
                      </p>
                      <input
                        value={noteInput}
                        onChange={(e) => { setNoteInput(e.target.value); setNoteSaved(false); }}
                        onKeyDown={(e) => { if (e.key === "Enter") void saveNote(); }}
                        maxLength={200}
                        placeholder="例: 見積もりの作成"
                        className="w-full border border-stone-400 bg-white px-1.5 py-1 text-xs
                                   placeholder:text-stone-400 focus:border-stone-600 focus:outline-none"
                      />
                      <div className="mt-1 flex gap-1">
                        <button onClick={saveNote} className="flex-1 border border-stone-800 bg-stone-800 px-2 py-1 text-xs text-stone-50 hover:bg-stone-700">
                          保存
                        </button>
                        <button onClick={clearNote} className={menuBtn + " flex-1 text-center"}>消す</button>
                      </div>
                      {noteError && <p className="mt-1 text-[10px] text-red-700">{noteError}</p>}
                      {noteSaved && !noteError && <p className="mt-1 text-[10px] text-emerald-700">保存しました</p>}
                    </div>
                    <button onClick={leaveVillage} className={menuBtn + " text-center"}>退勤（村から消える）</button>
                  </div>
                ) : (
                  <div className="space-y-1 text-xs">
                    <p className="text-stone-700">
                      話しかけて: {pickedPerson ? TALK_LABEL[(pickedPerson.talk ?? "ok") as TalkStatus] : "-"}
                    </p>
                    <p className="text-stone-700">
                      今日やること: {notes[picked.id] ? notes[picked.id] : <span className="text-stone-400">未記入</span>}
                    </p>
                    <p className="text-[10px] text-stone-500">他の人の状態は変えられません。</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {showRoster && (
          <aside className="w-72 shrink-0 border border-stone-300 bg-stone-50">
            <div className="flex items-baseline justify-between border-b border-stone-200 px-3 py-2">
              <h2 className="text-sm font-semibold">今日やること</h2>
              <span className="text-[11px] text-stone-500">{roster.length} 人</span>
            </div>
            <ul className="max-h-[calc(100vh-11rem)] divide-y divide-stone-200 overflow-y-auto">
              {roster.map((r) => (
                <li key={r.id} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={"h-2 w-2 shrink-0 rounded-full " + (r.state === "off" ? "bg-stone-300" : STATE_DOT[r.state])} />
                    {r.talk && TALK_TAG[r.talk] && (
                      <span className={"shrink-0 rounded-[2px] px-1 text-[9px] text-white " + (r.talk === "focus" ? "bg-red-800" : "bg-amber-700")}>
                        {TALK_TAG[r.talk]}
                      </span>
                    )}
                    <span className="truncate text-xs font-medium">{r.name}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-stone-500">
                      {r.state === "off" ? "村にいない" : STATE_LABEL[r.state]}
                    </span>
                  </div>
                  <p
                    className={"mt-0.5 line-clamp-2 pl-4 text-xs " + (r.note ? "text-stone-700" : "text-stone-400")}
                    title={r.note || undefined}
                  >
                    {r.note || "未記入"}
                  </p>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>

      {/* 画面下部の導線。oVice もコントロールを下に置いている */}
      <nav className="fixed inset-x-0 bottom-0 flex items-center gap-2 border-t border-stone-300 bg-stone-50/95 px-4 py-1.5 text-xs backdrop-blur">
        <span className="text-stone-500">自分のアバターを押すと、状態と今日やることを変えられます</span>
        {autoAway && (
          <span className="rounded-sm border border-amber-700/40 bg-amber-50 px-2 py-0.5 text-amber-900">
            {IDLE_MINUTES}分操作がないため離席にしました。戻すには自分のアバターを押して「在席」を選んでください
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <button onClick={() => setShowRoster((v) => !v)} className="border border-stone-400 bg-stone-50 px-2 py-1 hover:bg-stone-200">
            {showRoster ? "一覧を隠す" : "一覧を出す"}
          </button>
          <Link href="/attendance" className="border border-stone-400 bg-stone-50 px-2 py-1 hover:bg-stone-200">勤怠</Link>
          <Link href="/approvals" className="border border-stone-400 bg-stone-50 px-2 py-1 hover:bg-stone-200">承認</Link>
        </span>
      </nav>
      <div className="h-8" />
    </main>
  );
}
