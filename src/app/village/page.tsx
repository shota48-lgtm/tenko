"use client";

// 村の画面。
//
// 設計方針（崩さないこと）:
//   - 在席状態は WebSocket のみで扱う。DBには保存しない
//   - 投稿は HTTP。ここでは扱わない（建物を押すとチャット画面へ移る）
//   - 位置は状態が決める。ドラッグや矢印キーによる自由移動は実装しない
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ACTIVE_VARIANT, VARIANTS, sheet } from "@/sprites";
import {
  drawVillage, hitBuilding, VILLAGE_W, VILLAGE_H,
  type Presence, type Room,
} from "@/village/render";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";
const SCALE = 2;
const STATES: Presence["state"][] = ["idle", "away", "talking", "resting"];
const STATE_LABEL: Record<Presence["state"], string> = {
  idle: "在席", away: "離席", talking: "会話中", resting: "休憩中",
};

// 認証は Phase 1 の範囲外。利用者は暫定的に固定値で扱う
function devUser() {
  if (typeof window === "undefined") return { id: 1, name: "テスト太郎", colorIndex: 1 };
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
  const [conn, setConn] = useState<"接続中" | "切断" | "再接続中">("再接続中");
  const [myState, setMyState] = useState<Presence["state"]>("idle");
  const [stale, setStale] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const userRef = useRef(devUser());
  const myStateRef = useRef<Presence["state"]>("idle");

  useEffect(() => { myStateRef.current = myState; }, [myState]);

  // 部屋は HTTP で取る。建物の数は部屋の行数で決まる
  useEffect(() => {
    let alive = true;
    fetch("/api/rooms")
      .then((r) => r.json())
      .then((d) => { if (alive) setRooms(d.rooms ?? []); })
      .catch(() => { /* 取れなくても村は描く */ });
    return () => { alive = false; };
  }, []);

  const announce = useCallback((state: Presence["state"]) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: "presence.set", user: userRef.current, state, roomId: null }));
    return true;
  }, []);

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
        // 再接続したら、まず自分の状態を申告し直す。
        // サーバー側の在席は揮発なので、全員が申告し直すことで一覧が再構成される
        announce(myStateRef.current);
        ws.send(JSON.stringify({ type: "presence.sync" }));
      };
      ws.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data as string);
          // 差分ではなく全体を受け取る。切断中の変更を取りこぼしても追いつける
          if (d.type === "presence.list") setPeople(d.users ?? []);
        } catch { /* 解釈できない通知は捨てる */ }
      };
      ws.onclose = () => {
        if (closed) return;
        setConn("切断");
        // 切断中は最後に受け取った一覧を残したまま、古い情報である印を出す。
        // 消すと村が空になり「全員退勤した」ように見えるため（決定の理由はログに記載）
        setStale(true);
        timer = setTimeout(() => { delay = Math.min(delay * 2, 5000); connect(); }, delay);
      };
      ws.onerror = () => { /* close が続けて呼ばれるのでここでは何もしない */ };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [announce]);

  // 描画
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, VILLAGE_W, VILLAGE_H);
    drawVillage(ctx, sheet(variant), rooms, people);
  }, [rooms, people, variant]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const x = (e.clientX - rect.left) / SCALE;
    const y = (e.clientY - rect.top) / SCALE;
    const room = hitBuilding(rooms, x, y);
    if (room) router.push("/?room=" + room.id);
  };

  const changeState = (s: Presence["state"]) => {
    setMyState(s);
    announce(s);
  };

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
        <button onClick={() => { announce("idle"); wsRef.current?.send(JSON.stringify({ type: "presence.set", user: userRef.current, state: "off" })); }}>
          退勤（村から消える）
        </button>
      </p>
      <div style={{ overflow: "auto", border: "1px solid #ccc", display: "inline-block", background: "#000" }}>
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
      </div>
      <p style={{ fontSize: 12, color: "#555" }}>建物を押すと、その部屋のチャットが開きます。</p>
    </main>
  );
}
