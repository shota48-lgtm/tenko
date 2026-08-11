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
    <main className="min-h-screen bg-stone-100 text-stone-800">
      <header className="border-b border-stone-300 bg-stone-50">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <h1 className="text-base font-semibold tracking-wide">tenko</h1>
          <span className="text-sm text-stone-600">勤怠の確認</span>
          <span className="text-xs text-stone-500">利用者 {me}</span>
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

      <h2 className="mt-5 text-sm font-semibold">確認してほしい記録（{anomalies.length} 件）</h2>
      <p className="mt-1 text-xs text-stone-500">
        自動では直しません。内容を見て、必要なら下の修正申請を出してください。
        {thresholds && `（長時間の閾値 ${thresholds.longWorkHours} 時間 / 直近 ${thresholds.days} 日を対象）`}
      </p>
      {anomalies.length === 0 && (
        <p className="mt-2 rounded-sm border border-stone-300 bg-white px-3 py-5 text-center text-sm text-stone-500">確認が必要な記録はありません。</p>
      )}
      <ul className="mt-2 divide-y divide-stone-200 rounded-sm border border-stone-300 bg-white text-sm">
        {anomalies.map((a, i) => (
          <li key={i} className="px-3 py-2">
            <strong>{a.workDate}</strong> {a.displayName} ／ {labels[a.kind] ?? a.kind}
            <div className="text-xs text-stone-600">{a.detail}</div>
          </li>
        ))}
      </ul>

      <h2 className="mt-6 text-sm font-semibold">修正を申請する</h2>
      <p className="mt-1 text-xs text-stone-500">
        承認されるまで勤怠には反映されません。元の記録は書き換えず、新しい記録として残ります。
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-sm border border-stone-300 bg-white p-2">
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-sm border border-stone-400 bg-white px-2 py-1 text-xs">
          {["arrive", "leave", "break", "late"].map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>{" "}
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="rounded-sm border border-stone-400 bg-white px-2 py-1 text-xs" />
        <input placeholder="直す記録のID（押し忘れの追加なら空欄）" value={target}
          onChange={(e) => setTarget(e.target.value)} className="w-56 rounded-sm border border-stone-400 bg-white px-2 py-1 text-xs placeholder:text-stone-400" />
        <input placeholder="理由" value={reason} onChange={(e) => setReason(e.target.value)} className="w-64 rounded-sm border border-stone-400 bg-white px-2 py-1 text-xs placeholder:text-stone-400" />
        <button onClick={submit} className="rounded-sm border border-stone-800 bg-stone-800 px-3 py-1 text-xs text-stone-50 hover:bg-stone-700">申請</button>
      </div>

      <h2 className="mt-6 text-sm font-semibold">申請の状況（{corrections.length} 件）</h2>
      <ul className="mt-2 divide-y divide-stone-200 rounded-sm border border-stone-300 bg-white text-sm">
        {corrections.map((c) => (
          <li key={c.id} className="px-3 py-2">
            #{c.id} {c.display_name} ／ {c.work_date} ／ {KIND_LABEL[c.kind] ?? c.kind}{" "}
            {new Date(c.event_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{" "}
            <strong>{STATUS_LABEL[c.status] ?? c.status}</strong>
            <div className="text-xs text-stone-600">理由: {c.correction_reason}</div>
            {c.corrects_record_id && (
              <div className="text-[11px] text-stone-500">
                元の記録 #{c.corrects_record_id}
                {c.original_event_at && `（${new Date(c.original_event_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}）`}
              </div>
            )}
          </li>
        ))}
      </ul>
      </div>
    </main>
  );
}
