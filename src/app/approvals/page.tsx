"use client";

// 承認者の画面。
//
// 設計方針（崩さないこと）:
//   - 根拠の発言を必ず見せる。承認は他人の勤怠を認める行為であり、根拠なしに押させない
//   - 自動で承認しない。時間経過で承認しない
//   - ここで一覧やボタンを隠しても権限の担保にはならない。判定はAPI側で行っている
import { useCallback, useEffect, useState } from "react";

type Item = {
  id: number;
  user_id: number;
  display_name: string;
  kind: "arrive" | "leave" | "break" | "late";
  event_at: string;
  work_date: string;
  status: string;
  confirmed_at: string;
  source_body: string | null;
  matched_text: string | null;
  rule_id: string | null;
  source_deleted: boolean | null;
};

const KIND_LABEL: Record<Item["kind"], string> = { arrive: "出社", leave: "退勤", break: "休憩", late: "遅刻" };

function actorId() {
  if (typeof window === "undefined") return 1;
  return Number(new URLSearchParams(window.location.search).get("me") ?? 1);
}

export default function ApprovalsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [me, setMe] = useState(1);

  const load = useCallback(async (uid: number) => {
    const res = await fetch("/api/attendance/approvals?user=" + uid);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "一覧を取得できませんでした");
      setItems([]);
      return;
    }
    const j = await res.json();
    setError(null);
    setItems((j.items ?? []).map((x: Item) => ({ ...x, id: Number(x.id) })));
  }, []);

  useEffect(() => {
    // effect の本体から直接 setState すると連鎖描画になるため、一度キューに逃がす
    const t = setTimeout(() => {
      const uid = actorId();
      setMe(uid);
      void load(uid);
    }, 0);
    return () => clearTimeout(t);
  }, [load]);

  const act = async (id: number, action: "approve" | "return") => {
    const body: Record<string, unknown> = { action, user: me };
    if (action === "return") body.reason = reasons[id] ?? "";
    const res = await fetch("/api/attendance/approvals/" + id, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "操作できませんでした");
    }
    await load(me);
  };

  return (
    <main className="min-h-screen bg-stone-100 text-stone-800">
      <header className="border-b border-stone-300 bg-stone-50">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <h1 className="text-base font-semibold tracking-wide">tenko</h1>
          <span className="text-sm text-stone-600">承認</span>
          <span className="rounded-sm border border-stone-300 bg-white px-2 py-0.5 text-xs text-stone-600">
            承認待ち {items.length} 件
          </span>
          <span className="text-xs text-stone-500">承認者: 利用者 {me}</span>
          <a
            href="/village"
            className="ml-auto rounded-sm border border-stone-400 bg-stone-50 px-2.5 py-1 text-xs text-stone-700 hover:bg-stone-200"
          >
            村の画面へ
          </a>
        </div>
      </header>
      <div className="mx-auto max-w-4xl px-4 py-3">
      {error && (
        <p className="mb-2 rounded-sm border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>
      )}

      {items.length === 0 && !error && (
        <p className="rounded-sm border border-stone-300 bg-white px-3 py-6 text-center text-sm text-stone-500">承認待ちの記録はありません。</p>
      )}

      <ul className="divide-y divide-stone-200 rounded-sm border border-stone-300 bg-white">
        {items.map((it) => (
          <li key={it.id} className="px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{it.display_name}</span>
              <span className="text-xs text-stone-500">利用者 {it.user_id}</span>
              <span className="text-xs tabular-nums text-stone-600">{it.work_date}</span>
              <span className="rounded-sm bg-stone-800 px-1.5 py-0.5 text-[11px] text-stone-50">
                {KIND_LABEL[it.kind]}
              </span>
              <span className="text-sm tabular-nums">
                {new Date(it.event_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <div className="mt-1 text-xs text-stone-700">
              根拠の発言: 「{it.source_body ?? "(下書きなし)"}」
              {it.source_deleted && <span>（この発言は削除されています）</span>}
            </div>
            <div className="text-[11px] text-stone-500">
              一致した箇所: {it.matched_text ?? "-"} / ルール: {it.rule_id ?? "-"} / 本人の確定:{" "}
              {new Date(it.confirmed_at).toLocaleString()}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button onClick={() => act(it.id, "approve")} className="rounded-sm border border-stone-800 bg-stone-800 px-3 py-1 text-xs text-stone-50 hover:bg-stone-700">承認</button>
              <input
                placeholder="差し戻しの理由"
                value={reasons[it.id] ?? ""}
                onChange={(e) => setReasons({ ...reasons, [it.id]: e.target.value })}
                className="w-64 rounded-sm border border-stone-400 bg-white px-2 py-1 text-xs
                           placeholder:text-stone-400 focus:border-stone-600 focus:outline-none
                           focus:ring-2 focus:ring-amber-500/40"
              />
              <button
                onClick={() => act(it.id, "return")}
                className="rounded-sm border border-stone-400 bg-stone-50 px-3 py-1 text-xs text-stone-700 hover:bg-stone-200"
              >
                差し戻し
              </button>
            </div>
          </li>
        ))}
      </ul>
      </div>
    </main>
  );
}
