"use client";

// Phase 1 の最小画面。見た目は Phase 2 で作り直すため整えていない。
//
// 設計方針（崩さないこと）:
//   - 投稿は HTTP(POST) で保存する。WebSocket には流さない
//   - WebSocket は通知の受信専用。届かなくても after=<id> の差分取得で追いつける
//   - 送信に失敗した分はクライアント側の待ち行列に残し、復帰後に再送する。
//     再送しても重複しないことは DB の一意制約が保証する
import { useCallback, useEffect, useRef, useState } from "react";

const ROOM_ID = 1;
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

type Message = {
  id: number;
  user_id: number;
  display_name: string;
  client_msg_id: string;
  body: string | null;
  deleted: boolean;
  created_at: string;
};

type Pending = { clientMsgId: string; body: string };

type ConnState = "接続中" | "切断" | "再接続中";

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [conn, setConn] = useState<ConnState>("再接続中");
  const [input, setInput] = useState("");
  const lastIdRef = useRef(0);
  const pendingRef = useRef<Pending[]>([]);
  const sendingRef = useRef(false);

  const mergeMessages = useCallback((incoming: Message[]) => {
    if (incoming.length === 0) return;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      const added = incoming.filter((m) => !seen.has(m.id));
      if (added.length === 0) return prev;
      return [...prev, ...added].sort((a, b) => a.id - b.id);
    });
    const maxId = Math.max(...incoming.map((m) => m.id));
    if (maxId > lastIdRef.current) lastIdRef.current = maxId;
  }, []);

  // 差分取得。初回と再接続のたびに呼ぶ
  const fetchSince = useCallback(async () => {
    const res = await fetch(`/api/rooms/${ROOM_ID}/messages?after=${lastIdRef.current}`);
    if (!res.ok) return;
    const data = (await res.json()) as { messages: Message[] };
    mergeMessages(data.messages.map((m) => ({ ...m, id: Number(m.id) })));
  }, [mergeMessages]);

  // 待ち行列の送出。HTTP が通らない間は行列に残す
  const flushPending = useCallback(async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      while (pendingRef.current.length > 0) {
        const item = pendingRef.current[0];
        let ok = false;
        try {
          const res = await fetch(`/api/rooms/${ROOM_ID}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientMsgId: item.clientMsgId, body: item.body }),
          });
          // 4xx は送り直しても通らないので行列から外す。5xx と通信断は残して再送する
          ok = res.ok || (res.status >= 400 && res.status < 500);
        } catch {
          ok = false;
        }
        if (!ok) break;
        pendingRef.current = pendingRef.current.slice(1);
        setPending([...pendingRef.current]);
      }
    } finally {
      sendingRef.current = false;
      await fetchSince();
    }
  }, [fetchSince]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      setConn("再接続中");
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        delay = 1000;
        setConn("接続中");
        // 切断中に他の人が投稿した分をここで埋める
        void fetchSince();
        void flushPending();
      };

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data as string);
          if (data.type === "message.created" && data.message) {
            const m = data.message;
            if (Number(m.room_id) !== ROOM_ID) return;
            // 通知は取りこぼしうるので、通知を合図に差分取得もかける
            void fetchSince();
          }
        } catch {
          // 解釈できない通知は捨てる
        }
      };

      ws.onclose = () => {
        if (closed) return;
        setConn("切断");
        timer = setTimeout(() => {
          delay = Math.min(delay * 2, 5000);
          setConn("再接続中");
          connect();
        }, delay);
      };

      ws.onerror = () => {
        // close が続けて呼ばれるので、ここでは状態を変えない
      };
    };

    void fetchSince();
    connect();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [fetchSince, flushPending]);

  const onSend = () => {
    const body = input.trim();
    if (body.length === 0) return;
    const item: Pending = { clientMsgId: crypto.randomUUID(), body };
    pendingRef.current = [...pendingRef.current, item];
    setPending([...pendingRef.current]);
    setInput("");
    void flushPending();
  };

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif", maxWidth: 720 }}>
      <h1>tenko / 部屋 {ROOM_ID}</h1>
      <p>
        接続状態: <strong data-testid="conn">{conn}</strong>
        {pending.length > 0 && <span>（未送信 {pending.length} 件）</span>}
      </p>

      <ul>
        {messages.map((m) => (
          <li key={m.id}>
            <span>#{m.id}</span> <strong>{m.display_name}</strong>{" "}
            {m.deleted ? <em>（削除された投稿）</em> : m.body}{" "}
            <small>{new Date(m.created_at).toLocaleTimeString()}</small>
          </li>
        ))}
      </ul>

      {pending.length > 0 && (
        <ul>
          {pending.map((p) => (
            <li key={p.clientMsgId} style={{ opacity: 0.5 }}>
              {p.body} <small>（未送信・復帰後に再送）</small>
            </li>
          ))}
        </ul>
      )}

      <div>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSend();
          }}
          placeholder="発言を入力"
        />
        <button onClick={onSend}>送信</button>
      </div>
    </main>
  );
}