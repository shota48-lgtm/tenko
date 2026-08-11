"use client";

// 村の画面。
//
// 設計方針（崩さないこと）:
//   - 在席状態と「話しかけてよいか」は WebSocket のみ。DBには保存しない
//   - 「今日やること」は HTTP + DB。他人にも見えるため、入力の検証はサーバー側で行う
//   - 投稿は HTTP。ここでは扱わない（建物を押すとチャット画面へ移る）
//   - 位置は状態が決める。ドラッグや矢印キーによる自由移動は実装しない
//   - 自動で変えてよいのは「離席」への切り替えだけ。人がいることを機械が主張しない
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ACTIVE_VARIANT, VARIANTS, sheet } from "@/sprites";
import {
  drawVillage, drawBubbles, bubbleLayoutFor, hitBuilding, VILLAGE_W, VILLAGE_H,
  type Presence, type Room, type NoteMap, type TalkStatus,
} from "@/village/render";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";
const SCALE = 2;
const STATES: Presence["state"][] = ["idle", "away", "talking", "resting"];
const STATE_LABEL: Record<Presence["state"], string> = {
  idle: "在席", away: "離席", talking: "会話中", resting: "休憩中",
};
const TALK_LABEL: Record<TalkStatus, string> = {
  ok: "話しかけてOK", later: "後でならOK", focus: "集中中",
};
// 自動離席までの時間。仮説であり、実運用で調整する前提の値
const IDLE_MINUTES = Number(process.env.NEXT_PUBLIC_TENKO_IDLE_MINUTES ?? 10);
// 吹き出しの描き方。案A=Canvasに描く / 案B=HTMLを重ねる。比較のため両方持つ
type BubbleMode = "canvas" | "html";

// 認証は未実装。利用者は暫定的に固定値で扱う
function devUser() {
  if (typeof window === "undefined") return { id: 1, name: "利用者1", colorIndex: 1 };
  const q = new URLSearchParams(window.location.search);
  const id = Number(q.get("me") ?? 1);
  return { id, name: q.get("name") ?? "利用者" + id, colorIndex: ((id - 1) % 4) + 1 };
}

export default function VillagePage() {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [variant, setVariant] = useState<"a" | "b" | "c">(ACTIVE_VARIANT);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [people, setPeople] = useState<Presence[]>([]);
  const [notes, setNotes] = useState<NoteMap>({});
  const [conn, setConn] = useState<"接続中" | "切断" | "再接続中">("再接続中");
  const [myState, setMyState] = useState<Presence["state"]>("idle");
  const [talk, setTalk] = useState<TalkStatus>("ok");
  const [stale, setStale] = useState(false);
  const [noteInput, setNoteInput] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [bubbleMode, setBubbleMode] = useState<BubbleMode>("html");
  const [autoAway, setAutoAway] = useState(false);
  const [me, setMe] = useState({ id: 1, name: "利用者1", colorIndex: 1 });

  const wsRef = useRef<WebSocket | null>(null);
  const userRef = useRef(me);
  const myStateRef = useRef<Presence["state"]>("idle");
  const talkRef = useRef<TalkStatus>("ok");
  const lastActiveRef = useRef<number>(0);
  const manualAwayRef = useRef(false);

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

  const loadMyNote = useCallback(async (uid: number) => {
    try {
      const res = await fetch("/api/notes?user=" + uid);
      if (!res.ok) return;
      const d = await res.json();
      setNoteInput(d.note?.body ?? "");
    } catch { /* 無視 */ }
  }, []);

  // 部屋は HTTP で取る
  useEffect(() => {
    const t = setTimeout(() => {
      const u = devUser();
      setMe(u);
      userRef.current = u;
      void fetch("/api/rooms").then((r) => r.json()).then((d) => setRooms(d.rooms ?? [])).catch(() => {});
      void loadNotes();
      void loadMyNote(u.id);
    }, 0);
    return () => clearTimeout(t);
  }, [loadNotes, loadMyNote]);

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
          if (d.type === "presence.list") setPeople(d.users ?? []);
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

  // 自動離席（機能2）。
  // 操作が無い時間が閾値を超えたら away にする。戻すのは手動のみ。
  // 「人がいる」ことを機械が勝手に主張しないため、idle への自動復帰はしない
  useEffect(() => {
    lastActiveRef.current = Date.now();
    const touch = () => { lastActiveRef.current = Date.now(); };
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "wheel", "touchstart"];
    for (const ev of events) window.addEventListener(ev, touch, { passive: true });
    const onVisible = () => { if (document.visibilityState === "visible") touch(); };
    document.addEventListener("visibilitychange", onVisible);

    const timer = setInterval(() => {
      if (myStateRef.current === "away") return;
      const idleMs = Date.now() - lastActiveRef.current;
      if (idleMs >= IDLE_MINUTES * 60_000) {
        manualAwayRef.current = false;
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

  // 通知を受けたら今日やることも取り直す（他人が書き換えている可能性がある）
  useEffect(() => {
    const t = setInterval(() => { void loadNotes(); }, 30_000);
    return () => clearInterval(t);
  }, [loadNotes]);

  // 描画
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, VILLAGE_W, VILLAGE_H);
    drawVillage(ctx, sheet(variant), rooms, people);
    if (bubbleMode === "canvas") {
      drawBubbles(ctx, sheet(variant), bubbleLayoutFor(rooms, people, notes));
    }
  }, [rooms, people, notes, variant, bubbleMode]);

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
    manualAwayRef.current = s === "away";
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
    await loadNotes();
  };

  const clearNote = async () => {
    await fetch("/api/notes", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: me.id }),
    });
    setNoteInput("");
    await loadNotes();
  };

  const layout = bubbleLayoutFor(rooms, people, notes);

  return (
    <main style={{ padding: 16, fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 18 }}>tenko / 村</h1>

      <p style={{ fontSize: 13 }}>
        接続状態: <strong>{conn}</strong>
        {stale && <span>（表示は切断前の情報です）</span>}
        ／ 部屋 {rooms.length} / 村の人 {people.length}
        ／ 見た目:{" "}
        {(["a", "b", "c"] as const).map((k) => (
          <button key={k} onClick={() => setVariant(k)} disabled={k === variant} style={{ marginRight: 4 }}>
            {k.toUpperCase()} {VARIANTS[k].meta.name}
          </button>
        ))}
      </p>

      <p style={{ fontSize: 13 }}>
        自分の状態:{" "}
        {STATES.map((s) => (
          <button key={s} onClick={() => changeState(s)} disabled={s === myState} style={{ marginRight: 4 }}>
            {STATE_LABEL[s]}
          </button>
        ))}
        {autoAway && <span style={{ color: "#a60" }}>（{IDLE_MINUTES}分操作がないため自動で離席にしました。戻すには押してください）</span>}
      </p>

      <p style={{ fontSize: 13 }}>
        話しかけて:{" "}
        {(["ok", "later", "focus"] as const).map((t) => (
          <button key={t} onClick={() => changeTalk(t)} disabled={t === talk} style={{ marginRight: 4 }}>
            {TALK_LABEL[t]}
          </button>
        ))}
      </p>

      <p style={{ fontSize: 13 }}>
        今日やること:{" "}
        <input
          value={noteInput}
          onChange={(e) => setNoteInput(e.target.value)}
          maxLength={200}
          placeholder="例: 見積もりの作成と、15時の打ち合わせ"
          style={{ width: 380 }}
        />{" "}
        <button onClick={saveNote}>保存</button>{" "}
        <button onClick={clearNote}>消す</button>
        {noteError && <span style={{ color: "#a33" }}>　{noteError}</span>}
        <span style={{ color: "#666" }}>　日付が変わると自動で空になります</span>
      </p>

      <p style={{ fontSize: 13 }}>
        吹き出しの出し方:{" "}
        <button onClick={() => setBubbleMode("html")} disabled={bubbleMode === "html"}>案B: HTMLを重ねる</button>{" "}
        <button onClick={() => setBubbleMode("canvas")} disabled={bubbleMode === "canvas"}>案A: ドット絵に描く</button>
        {layout.hiddenCount > 0 && <span>　（吹き出しは {layout.boxes.length} 件まで表示。他 {layout.hiddenCount} 人）</span>}
      </p>

      <div style={{ overflow: "auto", border: "1px solid #ccc", display: "inline-block", background: "#000" }}>
        <div style={{ position: "relative", width: VILLAGE_W * SCALE, height: VILLAGE_H * SCALE }}>
          <canvas
            ref={canvasRef}
            width={VILLAGE_W}
            height={VILLAGE_H}
            onClick={onClick}
            style={{
              width: VILLAGE_W * SCALE,
              height: VILLAGE_H * SCALE,
              imageRendering: "pixelated",
              cursor: "pointer",
              display: "block",
            }}
          />
          {bubbleMode === "html" && layout.boxes.map((b) => (
            // 本文は React のテキストとして入れる。HTMLとして解釈させない（dangerouslySetInnerHTML は使わない）
            <div
              key={b.userId}
              style={{
                position: "absolute",
                left: b.x * SCALE,
                top: b.y * SCALE,
                maxWidth: 200,
                background: "#f4efe2",
                border: "1px solid #3f382c",
                borderRadius: 3,
                padding: "2px 5px",
                fontSize: 11,
                lineHeight: "13px",
                color: "#2b2823",
                pointerEvents: "none",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {b.lines.join("")}
            </div>
          ))}
        </div>
      </div>
      <p style={{ fontSize: 12, color: "#555" }}>建物を押すと、その部屋のチャットが開きます。</p>
    </main>
  );
}
