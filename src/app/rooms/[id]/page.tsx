"use client";

// Phase 1 の最小画面。見た目は Phase 2 で作り直すため整えていない。
//
// 設計方針（崩さないこと）:
//   - 投稿は HTTP(POST) で保存する。WebSocket には流さない
//   - WebSocket は通知の受信専用。届かなくても after=<id> の差分取得で追いつける
//   - 送信に失敗した分はクライアント側の待ち行列に残し、復帰後に再送する。
//     再送しても重複しないことは DB の一意制約が保証する
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

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
  // 部屋は URL の /rooms/<id> から取る。
  // window.location を読む形にしていたところ、転送の直後に古い値を読んで
  // 「部屋 1」と表示された（実機で確認）。ルーターの値を使う
  const params = useParams<{ id: string }>();
  const roomId = Number(params?.id ?? 1) || 1;
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [conn, setConn] = useState<ConnState>("再接続中");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [input, setInput] = useState("");
  const [roomName, setRoomName] = useState<string>("");
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

  // 部屋の名前。番号だけでは、どの部屋にいるのか分からない
  useEffect(() => {
    void fetch("/api/rooms").then((r) => r.json())
      .then((d: { rooms: { id: number; name: string }[] }) => {
        setRoomName(d.rooms.find((r) => Number(r.id) === roomId)?.name ?? "");
      }).catch(() => {});
  }, [roomId]);

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
    <main className="min-h-screen" style={{ background: "var(--tk-paper)" }}>
      <header className="tk-head">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
          <h1 className="text-sm font-bold tracking-widest">tenko</h1>
          <span className="text-sm font-bold">{roomName || "部屋 " + roomId}</span>
          {/* 正常な接続は既定なので出さない。切断のときだけ出す */}
          {conn !== "接続中" && (
            <span
              className="border border-[var(--tk-ink)] px-2 py-0.5 text-xs font-bold text-white"
              style={{ background: "var(--tk-red)" }}
            >
              <span data-testid="conn">{conn === "切断" ? "切断されました" : "つなぎ直しています"}</span>
              {pending.length > 0 && <span>（未送信 {pending.length} 件）</span>}
            </span>
          )}
          {conn === "接続中" && <span className="hidden" data-testid="conn">{conn}</span>}
          <Link href="/" className="tk-btn tk-btn-quiet ml-auto text-xs">村へ戻る</Link>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-3">
        {drafts.length > 0 && (
          <section className="tk-panel mb-3">
            <div className="tk-head px-3 py-2">
              <h2 className="text-sm font-bold">勤怠の下書き（未確定 {drafts.length} 件）</h2>
              <p className="mt-0.5 text-xs">
                発言から自動で立てた下書きです。確定するまで勤怠には記録されません。
              </p>
            </div>
            <ul>
              {drafts.map((d) => (
                <li key={d.id} className="tk-sep px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 text-[11px] text-white" style={{ background: "var(--tk-wood)" }}>
                      {KIND_LABEL[d.kind]}
                    </span>
                    <span className="text-sm tabular-nums">
                      {new Date(d.event_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span className="ml-auto flex gap-2">
                      <button onClick={() => decide(d.id, "confirm")} className="tk-btn text-xs">確定</button>
                      <button onClick={() => decide(d.id, "reject")} className="tk-btn tk-btn-quiet text-xs">却下</button>
                    </span>
                  </div>
                  <p className="mt-1 text-xs">
                    根拠の発言: 「{d.source_body ?? "(本文なし)"}」
                    {d.source_deleted && <span style={{ color: "var(--tk-ink-soft)" }}>（この発言は削除されています）</span>}
                  </p>
                  <p className="text-[11px]" style={{ color: "var(--tk-ink-soft)" }}>
                    一致した箇所: {d.matched_text} / ルール: {d.rule_id}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 発言の並び。アイコン・名前・本文・時刻の順に置く。
            本文は通常のゴシックで、行間を広めに取る（長文が読めなくなる装飾はしない）*/}
        <section className="tk-panel">
          <ul className="max-h-[calc(100vh-15rem)] overflow-y-auto">
            {messages.length === 0 && (
              <li className="px-3 py-6 text-center text-xs" style={{ color: "var(--tk-ink-soft)" }}>まだ発言がありません</li>
            )}
            {messages.map((m) => (
              <li key={m.id} className="tk-sep flex gap-2.5 px-3 py-2.5">
                <span className="tk-icon mt-0.5 shrink-0 text-xs font-bold" aria-hidden="true">
                  {(m.display_name || "?").slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-bold">{m.display_name}</span>
                    <span className="text-[11px] tabular-nums" style={{ color: "var(--tk-ink-soft)" }}>
                      {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span className="ml-auto text-[11px] tabular-nums" style={{ color: "var(--tk-ink-soft)" }}>#{m.id}</span>
                  </div>
                  <p
                    className={"mt-0.5 text-sm leading-6 " + (m.deleted ? "italic" : "")}
                    style={{ color: m.deleted ? "var(--tk-ink-soft)" : "var(--tk-ink)", wordBreak: "break-word" }}
                  >
                    {m.deleted ? "（削除された投稿）" : m.body}
                  </p>
                </div>
              </li>
            ))}
            {pending.map((p) => (
              <li key={p.clientMsgId} className="tk-sep flex gap-2.5 px-3 py-2.5" style={{ background: "var(--tk-paper-2)" }}>
                <span className="tk-icon mt-0.5 shrink-0 text-xs" aria-hidden="true">…</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[11px]" style={{ color: "var(--tk-ink-soft)" }}>未送信・つながったら送ります</span>
                  </div>
                  <p className="mt-0.5 text-sm leading-6" style={{ wordBreak: "break-word" }}>{p.body}</p>
                </div>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-2 border-t border-[var(--tk-ink)] p-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onSend(); }}
              placeholder="発言を入力"
              className="tk-input flex-1 py-1.5 text-sm"
            />
            <button onClick={onSend} className="tk-btn px-4 py-1.5 text-sm">送信</button>
          </div>
        </section>
      </div>
    </main>
  );
}