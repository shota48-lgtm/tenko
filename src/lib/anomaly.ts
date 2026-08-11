// 勤怠異常の検出。
//
// 設計方針（崩さないこと）:
//   - ルールベースのみ。LLM も外部APIも使わない
//   - 自動修正しない。既存の attendance_records を一切書き換えない。読むだけ
//   - 出すのは「確認してください」という提示。判断は人間が行う
//   - 閾値は環境変数。値は仮説であり、実運用で調整する前提
import { pool } from "@/lib/db";
import { TENKO_TZ } from "@/lib/notes";

export const LONG_WORK_HOURS = Number(process.env.TENKO_LONG_WORK_HOURS ?? 12);
export const ANOMALY_DAYS = Number(process.env.TENKO_ANOMALY_DAYS ?? 31);

export type AnomalyKind = "no_leave" | "long_work" | "message_without_arrive";

export type Anomaly = {
  userId: number;
  displayName: string;
  workDate: string;
  kind: AnomalyKind;
  detail: string;
  arriveAt: string | null;
  leaveAt: string | null;
};

export const ANOMALY_LABEL: Record<AnomalyKind, string> = {
  no_leave: "退勤の記録がない",
  long_work: "勤務時間が長い",
  message_without_arrive: "出社の記録がないのに発言がある",
};

// 対象となる利用者を、見る側の権限に応じて決める。
// 自分 / 自分の部下 / （admin なら）全員。ここを飛ばして他人の異常は取れない
export async function targetUserIds(actorId: number, role: string): Promise<number[]> {
  if (role === "admin") {
    const { rows } = await pool.query(`SELECT id FROM users WHERE deleted_at IS NULL ORDER BY id`);
    return rows.map((r) => Number(r.id));
  }
  if (role === "manager") {
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE deleted_at IS NULL AND (id = $1 OR manager_id = $1) ORDER BY id`, [actorId]);
    return rows.map((r) => Number(r.id));
  }
  return [actorId];
}

// 異常を探す。読み取りのみ。
// 今日の分は「まだ退勤していないだけ」の可能性があるため、退勤なしの判定から除く
export async function findAnomalies(userIds: number[]): Promise<Anomaly[]> {
  if (userIds.length === 0) return [];

  const { rows } = await pool.query(
    `WITH days AS (
       SELECT r.user_id, r.work_date,
              min(r.event_at) FILTER (WHERE r.kind = 'arrive') AS arrive_at,
              max(r.event_at) FILTER (WHERE r.kind = 'leave')  AS leave_at
         FROM attendance_records r
        WHERE r.user_id = ANY($1::bigint[])
          AND r.work_date >= (now() AT TIME ZONE $2)::date - $3::int
        GROUP BY r.user_id, r.work_date
     ),
     said AS (
       SELECT m.user_id, (m.created_at AT TIME ZONE $2)::date AS work_date, count(*)::int AS n
         FROM messages m
        WHERE m.user_id = ANY($1::bigint[])
          AND m.deleted_at IS NULL
          AND (m.created_at AT TIME ZONE $2)::date >= (now() AT TIME ZONE $2)::date - $3::int
        GROUP BY m.user_id, (m.created_at AT TIME ZONE $2)::date
     ),
     keys AS (
       SELECT user_id, work_date FROM days
       UNION
       SELECT user_id, work_date FROM said
     )
     SELECT u.id AS user_id, u.display_name,
            k.work_date::text AS work_date,
            d.arrive_at, d.leave_at, COALESCE(s.n, 0) AS said_count,
            (now() AT TIME ZONE $2)::date::text AS today
       FROM keys k
       JOIN users u ON u.id = k.user_id AND u.deleted_at IS NULL
       LEFT JOIN days d ON d.user_id = k.user_id AND d.work_date = k.work_date
       LEFT JOIN said s ON s.user_id = k.user_id AND s.work_date = k.work_date
      WHERE u.id = ANY($1::bigint[])
      ORDER BY k.work_date DESC, u.id`,
    [userIds, TENKO_TZ, ANOMALY_DAYS],
  );

  const out: Anomaly[] = [];
  for (const r of rows) {
    const isToday = r.work_date === r.today;
    const arrive = r.arrive_at ? new Date(r.arrive_at) : null;
    const leave = r.leave_at ? new Date(r.leave_at) : null;
    const base = {
      userId: Number(r.user_id),
      displayName: r.display_name,
      workDate: r.work_date,
      arriveAt: arrive ? arrive.toISOString() : null,
      leaveAt: leave ? leave.toISOString() : null,
    };

    // 1) 出社しているが退勤がない（今日は除く。まだ勤務中の可能性がある）
    if (arrive && !leave && !isToday) {
      out.push({ ...base, kind: "no_leave", detail: "出社の記録はあるが、退勤の記録がありません" });
    }
    // 2) 勤務時間が長い
    if (arrive && leave) {
      const hours = (leave.getTime() - arrive.getTime()) / 3_600_000;
      if (hours >= LONG_WORK_HOURS) {
        out.push({ ...base, kind: "long_work", detail: `出社から退勤まで ${hours.toFixed(1)} 時間（閾値 ${LONG_WORK_HOURS} 時間）` });
      }
    }
    // 3) 出社の記録がないのに発言がある
    if (!arrive && Number(r.said_count) > 0) {
      out.push({ ...base, kind: "message_without_arrive", detail: `発言が ${r.said_count} 件ありますが、出社の記録がありません` });
    }
  }
  return out;
}
