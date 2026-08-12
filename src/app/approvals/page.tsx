"use client";

// 承認者の画面。
//
// 設計方針（崩さないこと）:
//   - 根拠の発言を必ず見せる。承認は他人の勤怠を認める行為であり、根拠なしに押させない
//   - 自動で承認しない。時間経過で承認しない
//   - ここで一覧やボタンを隠しても権限の担保にはならない。判定はAPI側で行っている
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

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
  // 修正申請には下書きがない。代わりに理由と、直そうとしている元の記録を見せる
  correction_reason: string | null;
  corrects_record_id: number | null;
  original_event_at: string | null;
};

const KIND_LABEL: Record<Item["kind"], string> = { arrive: "出社", leave: "退勤", break: "休憩", late: "遅刻" };

// 誰として承認するかはサーバー（セッション）が決める。
// Phase 5 段階3 で、URL の ?me= を読む actorId() を削除した
export default function ApprovalsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<number, string>>({});
  // 押してから一覧が入れ替わるまでの間、押せたことが分かるようにする
  const [busy, setBusy] = useState<number | null>(null);
  const [me, setMe] = useState<{ id: number; role: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/attendance/approvals");
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "一覧を取得できませんでした");
      setItems([]);
      return;
    }
    const j = await res.json();
    setError(null);
    setMe(j.actor ?? null);
    setItems((j.items ?? []).map((x: Item) => ({ ...x, id: Number(x.id) })));
  }, []);

  useEffect(() => {
    // effect の本体から直接 setState すると連鎖描画になるため、一度キューに逃がす
    const t = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(t);
  }, [load]);

  const act = async (id: number, action: "approve" | "return") => {
    setBusy(id);
    setError(null);
    try {
      const body: Record<string, unknown> = { action };
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
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="min-h-screen" style={{ background: "var(--tk-paper)" }}>
      <header className="tk-head">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
          <h1 className="text-sm font-bold tracking-widest">tenko</h1>
          <span className="text-sm font-bold">承認</span>
          <span className="tk-panel px-2 py-0.5 text-xs">
            承認待ち {items.length} 件
          </span>
          <span className="text-xs tk-soft">{me ? "承認者: 利用者 " + me.id : "ログインが必要です"}</span>
          <Link href="/" className="tk-btn tk-btn-quiet ml-auto text-xs">村へ戻る</Link>
        </div>
      </header>
      <div className="mx-auto max-w-4xl px-4 py-3">
      {error && (
        <p className="mb-2 border border-[var(--tk-ink)] px-3 py-2 text-xs font-bold text-white" style={{ background: "var(--tk-red)" }}>{error}</p>
      )}

      {items.length === 0 && !error && (
        <p className="tk-panel px-3 py-6 text-center text-sm">承認待ちの記録はありません。</p>
      )}

      <ul className="tk-panel">
        {items.map((it) => (
          <li key={it.id} className="tk-sep px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{it.display_name}</span>
              <span className="text-xs tk-soft">利用者 {it.user_id}</span>
              <span className="text-xs tabular-nums tk-soft">{it.work_date}</span>
              <span className="px-1.5 py-0.5 text-[11px] text-white" style={{ background: "var(--tk-wood)" }}>
                {KIND_LABEL[it.kind]}
              </span>
              <span className="text-sm tabular-nums">
                {new Date(it.event_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            {it.correction_reason ? (
              // 修正申請には根拠の発言がない。押す判断の材料は「なぜ直すのか」と「元は何だったか」
              <div className="mt-1 text-xs">
                修正の申請です。理由: 「{it.correction_reason}」
                {it.corrects_record_id ? (
                  <span className="tk-soft">
                    　元の記録 #{it.corrects_record_id}
                    {it.original_event_at &&
                      `（${new Date(it.original_event_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}）`}
                  </span>
                ) : (
                  <span className="tk-soft">　（押し忘れの追加。元の記録なし）</span>
                )}
              </div>
            ) : (
              <div className="mt-1 text-xs">
                根拠の発言: 「{it.source_body ?? "(下書きなし)"}」
                {it.source_deleted && <span className="tk-soft">（この発言は削除されています）</span>}
              </div>
            )}
            <div className="text-[11px] tk-soft">
              {it.rule_id && <>一致した箇所: {it.matched_text} / ルール: {it.rule_id} / </>}
              本人の確定: {new Date(it.confirmed_at).toLocaleString()}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                onClick={() => act(it.id, "approve")}
                disabled={busy === it.id}
                className="tk-btn text-xs"
              >
                {busy === it.id ? "処理中…" : "承認"}
              </button>
              <input
                placeholder="差し戻しの理由"
                value={reasons[it.id] ?? ""}
                onChange={(e) => setReasons({ ...reasons, [it.id]: e.target.value })}
                className="tk-input w-64 text-xs"
              />
              <button
                onClick={() => act(it.id, "return")}
                disabled={busy === it.id}
                className="tk-btn tk-btn-quiet text-xs"
              >
                {busy === it.id ? "処理中…" : "差し戻し"}
              </button>
            </div>
          </li>
        ))}
      </ul>
      </div>
    </main>
  );
}
