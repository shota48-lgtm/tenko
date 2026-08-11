"use client";

// Phase 1 の最小画面。見た目は Phase 2 で作り直すため整えていない。
//
// 設計方針（崩さないこと）:
//   - 投稿は HTTP(POST) で保存する。WebSocket には流さない
//   - WebSocket は通知の受信専用。届かなくても after=<id> の差分取得で追いつける
//   - 送信に失敗した分はクライアント側の待ち行列に残し、復帰後に再送する。
//     再送しても重複しないことは DB の一意制約が保証する
import { useCallback, useEffect, useRef, useState } from "react";

function currentRoomId() {
  if (typeof window === "undefined") return 1;
  const q = Number(new URLSearchParams(window.location.search).get("room"));
  return Number.isInteger(q) && q > 0 ? q : 1;
}
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

// 勤怠の下書き。確定は必ず人間が押す。時間経過では確定しない
type Draft = {
  id: number;
  kind: "arrive" | "leave" | "break" | "late";
  event_at: string;
  status: "pending" | "confirmed" | "rejected";
  rule_id: string;
  matched_text: string;
  source_body: string | null;
  source_deleted: boolean;
};
const KIND_LABEL: Record<Draft["kind"], string> = { arrive: "出社", leave: "退勤", break: "休憩", late: "遅刻" };

type ConnState = "接続中" | "切断" | "再接続中";

export default function Home() {
  const roomId = typeof window === "undefined" ? 1 : currentRoomId();
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [conn, setConn] = useState<ConnState>("再接続中");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [input, setInput] = useState("");
  const lastIdRef = useRef(0);
  const pendingRef = useRef<Pending[]>([]);
  const sendingRef = useRef(false);

  // 自分の未確定の下書きを取り直す
  const fetchDrafts = useCallback(async () => {
    try {
      const res = await fetch("/api/attendance/drafts?status=pending");
      if (!res.ok) return;
      const d = (await res.json()) as { drafts: Draft[] };
      setDrafts(d.drafts.map((x) => ({ ...x, id: Number(x.id) })));
    } catch {
      // 取れなくてもチャットは動く
    }
  }, []);

  const decide = useCallback(async (id: number, action: "confirm" | "reject") => {
    await fetch("/api/attendance/drafts/" + id, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    void fetchDrafts();
  }, [fetchDrafts]);

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
    const res = await fetch(`/api/rooms/${roomId}/messages?after=${lastIdRef.current}`);
    if (!res.ok) return;
    const data = (await res.json()) as { messages: Message[] };
    mergeMessages(data.messages.map((m) => ({ ...m, id: Number(m.id) })));
  }, [mergeMessages, roomId]);

  // 待ち行列の送出。HTTP が通らない間は行列に残す
  const flushPending = useCallback(async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      while (pendingRef.current.length > 0) {
        const item = pendingRef.current[0];
        let ok = false;
        try {
          const res = await fetch(`/api/rooms/${roomId}/messages`, {
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
      // 送信した発言から下書きが立っている可能性があるので取り直す
      await fetchDrafts();
    }
  }, [fetchSince, fetchDrafts, roomId]);

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
            if (Number(m.room_id) !== roomId) return;
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
    // 初回の下書き取得。effect の本体から直接呼ぶと setState が同期的に走るため、
    // 一度キューに逃がしてから呼ぶ（WSが落ちていても下書きは表示したいので onopen には置かない）
    const firstDrafts = setTimeout(() => { void fetchDrafts(); }, 0);

    return () => {
      closed = true;
      clearTimeout(firstDrafts);
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [fetchSince, flushPending, fetchDrafts, roomId]);

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
      <h1>tenko / 部屋 {roomId}</h1>
      <p><a href="/village">村の画面へ</a></p>
      <p>
        接続状態: <strong data-testid="conn">{conn}</strong>
        {pending.length > 0 && <span>（未送信 {pending.length} 件）</span>}
      </p>

      {drafts.length > 0 && (
        <section style={{ border: "1px solid #c9a", padding: 8, margin: "12px 0" }}>
          <h2 style={{ fontSize: 15, margin: "0 0 6px" }}>勤怠の下書き（未確定 {drafts.length} 件）</h2>
          <p style={{ fontSize: 12, color: "#555", margin: "0 0 8px" }}>
            発言から自動で立てた下書きです。確定するまで勤怠には記録されません。
          </p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {drafts.map((d) => (
              <li key={d.id} style={{ marginBottom: 8 }}>
                <strong>{KIND_LABEL[d.kind]}</strong>{" "}
                {new Date(d.event_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                <div style={{ fontSize: 12, color: "#444" }}>
                  根拠の発言: 「{d.source_body ?? "(本文なし)"}」
                  {d.source_deleted && <span>（この発言は削除されています）</span>}
                </div>
                <div style={{ fontSize: 11, color: "#777" }}>
                  一致した箇所: {d.matched_text} / ルール: {d.rule_id}
                </div>
                <button onClick={() => decide(d.id, "confirm")}>確定</button>{" "}
                <button onClick={() => decide(d.id, "reject")}>却下</button>
              </li>
            ))}
          </ul>
        </section>
      )}

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