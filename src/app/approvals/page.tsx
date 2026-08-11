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
    <main style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 900 }}>
      <h1 style={{ fontSize: 18 }}>tenko / 承認</h1>
      <p style={{ fontSize: 13 }}>
        承認者: 利用者 {me}（`?me=` で切り替え）／ 承認待ち {items.length} 件
      </p>
      {error && <p style={{ color: "#a33", fontSize: 13 }}>{error}</p>}

      {items.length === 0 && !error && <p style={{ fontSize: 13 }}>承認待ちの記録はありません。</p>}

      <ul style={{ paddingLeft: 18 }}>
        {items.map((it) => (
          <li key={it.id} style={{ marginBottom: 14, borderBottom: "1px solid #ddd", paddingBottom: 10 }}>
            <div>
              <strong>{it.display_name}</strong>（利用者 {it.user_id}）／ {it.work_date} ／{" "}
              <strong>{KIND_LABEL[it.kind]}</strong>{" "}
              {new Date(it.event_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </div>
            <div style={{ fontSize: 12, color: "#444" }}>
              根拠の発言: 「{it.source_body ?? "(下書きなし)"}」
              {it.source_deleted && <span>（この発言は削除されています）</span>}
            </div>
            <div style={{ fontSize: 11, color: "#777" }}>
              一致した箇所: {it.matched_text ?? "-"} / ルール: {it.rule_id ?? "-"} / 本人の確定:{" "}
              {new Date(it.confirmed_at).toLocaleString()}
            </div>
            <div style={{ marginTop: 4 }}>
              <button onClick={() => act(it.id, "approve")}>承認</button>{" "}
              <input
                placeholder="差し戻しの理由"
                value={reasons[it.id] ?? ""}
                onChange={(e) => setReasons({ ...reasons, [it.id]: e.target.value })}
              />{" "}
              <button onClick={() => act(it.id, "return")}>差し戻し</button>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
