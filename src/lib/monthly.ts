// 月次の勤怠記録。
//
// これは給与計算の根拠になりうる出力である。
//   - 丸めない。推測しない。データに無い時刻は空欄のままにする
//   - 未承認を承認済みと混ぜない。行ごとに状態が分かる形にする
import { pool } from "@/lib/db";

export type { MonthlyRow, MonthlyResult } from "@/lib/monthly-format";
export { toCsv } from "@/lib/monthly-format";
import type { MonthlyRow, MonthlyResult } from "@/lib/monthly-format";

const HHMM = (v: string | null) =>
  v == null ? null : new Date(v).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" });

export async function monthly(userId: number, year: number, month: number): Promise<MonthlyResult | null> {
  const u = await pool.query(`SELECT id, display_name FROM users WHERE id = $1`, [userId]);
  if (u.rows.length === 0) return null;

  // 集計はSQLで行い、取ってきた値をそのまま出す。
  // 出社は最も早い時刻、退勤は最も遅い時刻。存在しない日は行が立たない
  const { rows } = await pool.query(
    `SELECT work_date::text AS work_date,
            min(event_at) FILTER (WHERE kind = 'arrive') AS arrive_at,
            max(event_at) FILTER (WHERE kind = 'leave')  AS leave_at,
            count(*) FILTER (WHERE kind = 'break')::int  AS break_count,
            count(*) FILTER (WHERE kind = 'late')::int   AS late_count,
            count(*) FILTER (WHERE status = 'approved')::int AS approved_count,
            count(*) FILTER (WHERE status <> 'approved')::int AS unapproved_count
       FROM attendance_records
      WHERE user_id = $1
        AND date_part('year', work_date) = $2
        AND date_part('month', work_date) = $3
      GROUP BY work_date
      ORDER BY work_date`,
    [userId, year, month],
  );

  const out: MonthlyRow[] = rows.map((r) => ({
    work_date: r.work_date,
    arrive_at: HHMM(r.arrive_at),
    leave_at: HHMM(r.leave_at),
    break_count: r.break_count,
    late_count: r.late_count,
    approved_count: r.approved_count,
    unapproved_count: r.unapproved_count,
    has_unapproved: r.unapproved_count > 0,
  }));

  return {
    user: { id: Number(u.rows[0].id), display_name: u.rows[0].display_name },
    year,
    month,
    rows: out,
    total: {
      work_days: out.filter((r) => r.arrive_at !== null).length,
      late_days: out.filter((r) => r.late_count > 0).length,
      break_total: out.reduce((a, r) => a + r.break_count, 0),
      approved: out.reduce((a, r) => a + r.approved_count, 0),
      unapproved: out.reduce((a, r) => a + r.unapproved_count, 0),
    },
  };
}

