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
    <main className="min-h-screen bg-stone-100 text-stone-800">
      <header className="border-b border-stone-300 bg-stone-50">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <h1 className="text-base font-semibold tracking-wide">tenko</h1>
          <span className="text-sm text-stone-600">部屋 {roomId}</span>
          <span
            className={
              "inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs " +
              (conn === "接続中"
                ? "border-emerald-700/30 bg-emerald-50 text-emerald-800"
                : "border-amber-700/30 bg-amber-50 text-amber-800")
            }
          >
            <span className={"h-1.5 w-1.5 rounded-full " + (conn === "接続中" ? "bg-emerald-600" : "bg-amber-500")} />
            <span data-testid="conn">{conn}</span>
            {pending.length > 0 && <span>（未送信 {pending.length} 件）</span>}
          </span>
          <Link href="/" className="ml-auto rounded-sm border border-stone-400 bg-stone-50 px-2.5 py-1 text-xs text-stone-700
                       hover:bg-stone-200 focus:outline-none focus:ring-2 focus:ring-amber-500/50">村へ戻る</Link>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-3">
        {drafts.length > 0 && (
          <section className="mb-3 rounded-sm border border-amber-700/40 bg-amber-50/60">
            <div className="border-b border-amber-700/20 px-3 py-2">
              <h2 className="text-sm font-semibold text-amber-900">勤怠の下書き（未確定 {drafts.length} 件）</h2>
              <p className="mt-0.5 text-xs text-amber-900/80">
                発言から自動で立てた下書きです。確定するまで勤怠には記録されません。
              </p>
            </div>
            <ul className="divide-y divide-amber-700/15">
              {drafts.map((d) => (
                <li key={d.id} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded-sm bg-amber-800 px-1.5 py-0.5 text-[11px] text-amber-50">
                      {KIND_LABEL[d.kind]}
                    </span>
                    <span className="text-sm tabular-nums">
                      {new Date(d.event_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span className="ml-auto flex gap-2">
                      <button
                        onClick={() => decide(d.id, "confirm")}
                        className="rounded-sm border border-stone-800 bg-stone-800 px-3 py-1 text-xs text-stone-50
                                   hover:bg-stone-700 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                      >
                        確定
                      </button>
                      <button
                        onClick={() => decide(d.id, "reject")}
                        className="rounded-sm border border-stone-400 bg-stone-50 px-3 py-1 text-xs text-stone-700
                                   hover:bg-stone-200 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                      >
                        却下
                      </button>
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-stone-700">
                    根拠の発言: 「{d.source_body ?? "(本文なし)"}」
                    {d.source_deleted && <span className="text-stone-500">（この発言は削除されています）</span>}
                  </p>
                  <p className="text-[11px] text-stone-500">
                    一致した箇所: {d.matched_text} / ルール: {d.rule_id}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="rounded-sm border border-stone-300 bg-white">
          <ul className="max-h-[calc(100vh-16rem)] divide-y divide-stone-100 overflow-y-auto">
            {messages.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-stone-400">まだ発言がありません</li>
            )}
            {messages.map((m) => (
              <li key={m.id} className="flex items-baseline gap-2 px-3 py-1.5">
                <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-stone-400">#{m.id}</span>
                <span className="shrink-0 text-xs font-medium text-stone-700">{m.display_name}</span>
                <span className={"text-sm " + (m.deleted ? "italic text-stone-400" : "")}>
                  {m.deleted ? "（削除された投稿）" : m.body}
                </span>
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-stone-400">
                  {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </li>
            ))}
            {pending.map((p) => (
              <li key={p.clientMsgId} className="flex items-baseline gap-2 bg-stone-50 px-3 py-1.5 text-stone-400">
                <span className="w-10 shrink-0 text-right text-[11px]">—</span>
                <span className="text-sm">{p.body}</span>
                <span className="ml-auto shrink-0 text-[11px]">未送信・復帰後に再送</span>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-2 border-t border-stone-200 p-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onSend(); }}
              placeholder="発言を入力"
              className="flex-1 rounded-sm border border-stone-400 bg-white px-2 py-1.5 text-sm
                         placeholder:text-stone-400 focus:border-stone-600 focus:outline-none
                         focus:ring-2 focus:ring-amber-500/40"
            />
            <button
              onClick={onSend}
              className="rounded-sm border border-stone-800 bg-stone-800 px-4 py-1.5 text-sm text-stone-50
                         hover:bg-stone-700 active:bg-stone-900 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            >
              送信
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}