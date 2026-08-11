"use client";

// 勤怠の確認画面。
//   - 勤怠異常の提示（機能4）。自動修正はしない。出すのは「確認してください」まで
//   - 修正申請（機能5）。承認は Phase 4 の仕組みを通る
//
// ここで一覧やボタンを隠しても権限の担保にはならない。判定はAPI側で行っている。
import { useCallback, useEffect, useState } from "react";

type Anomaly = {
  userId: number; displayName: string; workDate: string;
  kind: "no_leave" | "long_work" | "message_without_arrive";
  detail: string; arriveAt: string | null; leaveAt: string | null;
};
type Correction = {
  id: number; user_id: number; display_name: string; kind: string;
  event_at: string; work_date: string; status: string;
  correction_reason: string | null; corrects_record_id: number | null;
  original_kind: string | null; original_event_at: string | null;
};

const KIND_LABEL: Record<string, string> = { arrive: "出社", leave: "退勤", break: "休憩", late: "遅刻" };
const STATUS_LABEL: Record<string, string> = { submitted: "承認待ち", approved: "承認済み", returned: "差し戻し" };

function actorId() {
  if (typeof window === "undefined") return 1;
  return Number(new URLSearchParams(window.location.search).get("me") ?? 1);
}

export default function AttendancePage() {
  const [me, setMe] = useState(1);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [thresholds, setThresholds] = useState<{ longWorkHours: number; days: number } | null>(null);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 修正申請の入力
  const [kind, setKind] = useState("leave");
  const [when, setWhen] = useState("");
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState("");

  const load = useCallback(async (uid: number) => {
    try {
      const a = await fetch("/api/attendance/anomalies?user=" + uid);
      if (a.ok) {
        const j = await a.json();
        setAnomalies(j.anomalies ?? []);
        setLabels(j.labels ?? {});
        setThresholds(j.thresholds ?? null);
      }
      const c = await fetch("/api/attendance/corrections?user=" + uid);
      if (c.ok) {
        const j = await c.json();
        setCorrections(j.corrections ?? []);
      }
    } catch {
      setError("取得できませんでした");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      const uid = actorId();
      setMe(uid);
      void load(uid);
    }, 0);
    return () => clearTimeout(t);
  }, [load]);

  const submit = async () => {
    setError(null);
    const body: Record<string, unknown> = { user: me, kind, eventAt: when, reason };
    if (target.trim() !== "") body.correctsRecordId = Number(target);
    const r = await fetch("/api/attendance/corrections", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setError(j.error ?? "申請できませんでした");
      return;
    }
    setReason("");
    setTarget("");
    await load(me);
  };

  return (
    <main style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 900 }}>
      <h1 style={{ fontSize: 18 }}>tenko / 勤怠の確認</h1>
      <p style={{ fontSize: 13 }}>利用者 {me}（`?me=` で切り替え）</p>
      {error && <p style={{ color: "#a33", fontSize: 13 }}>{error}</p>}

      <h2 style={{ fontSize: 15, marginTop: 20 }}>確認してほしい記録（{anomalies.length} 件）</h2>
      <p style={{ fontSize: 12, color: "#555" }}>
        自動では直しません。内容を見て、必要なら下の修正申請を出してください。
        {thresholds && `（長時間の閾値 ${thresholds.longWorkHours} 時間 / 直近 ${thresholds.days} 日を対象）`}
      </p>
      {anomalies.length === 0 && <p style={{ fontSize: 13 }}>確認が必要な記録はありません。</p>}
      <ul style={{ fontSize: 13 }}>
        {anomalies.map((a, i) => (
          <li key={i} style={{ marginBottom: 6 }}>
            <strong>{a.workDate}</strong> {a.displayName} ／ {labels[a.kind] ?? a.kind}
            <div style={{ color: "#444", fontSize: 12 }}>{a.detail}</div>
          </li>
        ))}
      </ul>

      <h2 style={{ fontSize: 15, marginTop: 24 }}>修正を申請する</h2>
      <p style={{ fontSize: 12, color: "#555" }}>
        承認されるまで勤怠には反映されません。元の記録は書き換えず、新しい記録として残ります。
      </p>
      <div style={{ fontSize: 13 }}>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {["arrive", "leave", "break", "late"].map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>{" "}
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />{" "}
        <input placeholder="直す記録のID（押し忘れの追加なら空欄）" value={target}
          onChange={(e) => setTarget(e.target.value)} style={{ width: 220 }} />{" "}
        <input placeholder="理由" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 260 }} />{" "}
        <button onClick={submit}>申請</button>
      </div>

      <h2 style={{ fontSize: 15, marginTop: 24 }}>申請の状況（{corrections.length} 件）</h2>
      <ul style={{ fontSize: 13 }}>
        {corrections.map((c) => (
          <li key={c.id} style={{ marginBottom: 6 }}>
            #{c.id} {c.display_name} ／ {c.work_date} ／ {KIND_LABEL[c.kind] ?? c.kind}{" "}
            {new Date(c.event_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{" "}
            <strong>{STATUS_LABEL[c.status] ?? c.status}</strong>
            <div style={{ fontSize: 12, color: "#444" }}>理由: {c.correction_reason}</div>
            {c.corrects_record_id && (
              <div style={{ fontSize: 11, color: "#777" }}>
                元の記録 #{c.corrects_record_id}
                {c.original_event_at && `（${new Date(c.original_event_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}）`}
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
