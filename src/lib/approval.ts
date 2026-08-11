// 勤怠記録の承認・差し戻し。
//
// 設計方針（崩さないこと）:
//   - 本人の確定と、上長の承認は別の行為。本人が確定しても承認までは勤怠として確定しない
//   - 自動で承認しない。時間経過で承認しない。人間が押したときだけ状態が変わる
//   - 他人の記録を承認できるかの判定は必ずここ（API側）で行う。画面を隠すだけでは防げない
import { pool } from "@/lib/db";

export type Role = "member" | "manager" | "admin";
export type RecordStatus = "submitted" | "approved" | "returned";

export type Actor = { id: number; role: Role };

export async function getActor(userId: number): Promise<Actor | null> {
  const { rows } = await pool.query(
    `SELECT id, role FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (rows.length === 0) return null;
  return { id: Number(rows[0].id), role: rows[0].role as Role };
}

// 承認できるかの判定。
//   member : 誰の記録も承認できない（自分のものも含む。承認は他人が行う行為）
//   manager: 自分が manager_id に指定されている部下の記録のみ
//   admin  : 全員
export async function canApprove(actor: Actor, targetUserId: number): Promise<{ ok: boolean; reason?: string }> {
  if (actor.role === "admin") return { ok: true };
  if (actor.role !== "manager") return { ok: false, reason: "承認できるのは manager か admin のみです" };
  if (actor.id === targetUserId) return { ok: false, reason: "自分の記録は自分で承認できません" };
  const { rows } = await pool.query(`SELECT manager_id FROM users WHERE id = $1`, [targetUserId]);
  if (rows.length === 0) return { ok: false, reason: "対象の利用者が見つかりません" };
  const managerId = rows[0].manager_id == null ? null : Number(rows[0].manager_id);
  if (managerId !== actor.id) return { ok: false, reason: "この利用者の承認者ではありません" };
  return { ok: true };
}

// 本人が下書きを確定したときに、承認待ちの記録を作る。
// 二度押しても増えない（draft_id の一意制約 + ON CONFLICT DO NOTHING）
export async function createRecordFromDraft(draftId: number) {
  const { rows } = await pool.query(
    `INSERT INTO attendance_records
       (user_id, draft_id, kind, event_at, work_date, status, confirmed_at)
     SELECT d.user_id, d.id, d.kind, d.event_at, (d.event_at AT TIME ZONE 'Asia/Tokyo')::date,
            'submitted', COALESCE(d.decided_at, now())
       FROM attendance_drafts d
      WHERE d.id = $1 AND d.status = 'confirmed'
     ON CONFLICT (draft_id) WHERE draft_id IS NOT NULL DO NOTHING
     RETURNING id, user_id, kind, event_at, work_date, status`,
    [draftId],
  );
  return rows[0] ?? null;
}

// 承認待ちの一覧。根拠の発言を必ず付ける（根拠なしに承認させない）
export async function listPendingApprovals(actor: Actor) {
  const { rows } = await pool.query(
    `SELECT r.id, r.user_id, u.display_name, r.kind, r.event_at, r.work_date,
            r.status, r.confirmed_at, r.return_reason,
            d.source_body, d.matched_text, d.rule_id,
            m.deleted_at IS NOT NULL AS source_deleted
       FROM attendance_records r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN attendance_drafts d ON d.id = r.draft_id
       LEFT JOIN messages m ON m.id = d.message_id
      WHERE r.status = 'submitted'
        AND ($1 = 'admin' OR u.manager_id = $2)
      ORDER BY r.work_date DESC, r.event_at DESC
      LIMIT 500`,
    [actor.role, actor.id],
  );
  return rows;
}

// 自分の記録の一覧（本人が状態を確認するため）
export async function listOwnRecords(userId: number) {
  const { rows } = await pool.query(
    `SELECT r.id, r.kind, r.event_at, r.work_date, r.status, r.confirmed_at,
            r.approved_at, r.returned_at, r.return_reason, d.source_body
       FROM attendance_records r
       LEFT JOIN attendance_drafts d ON d.id = r.draft_id
      WHERE r.user_id = $1
      ORDER BY r.id DESC
      LIMIT 200`,
    [userId],
  );
  return rows;
}

export async function approveRecord(recordId: number, actor: Actor) {
  const { rows } = await pool.query(
    `UPDATE attendance_records
        SET status = 'approved', approved_at = now(), approved_by = $1,
            returned_at = NULL, returned_by = NULL, return_reason = NULL
      WHERE id = $2 AND status IN ('submitted')
      RETURNING id, user_id, status, approved_at, approved_by`,
    [actor.id, recordId],
  );
  return rows[0] ?? null;
}

export async function returnRecord(recordId: number, actor: Actor, reason: string) {
  const { rows } = await pool.query(
    `UPDATE attendance_records
        SET status = 'returned', returned_at = now(), returned_by = $1, return_reason = $2,
            approved_at = NULL, approved_by = NULL
      WHERE id = $3 AND status = 'submitted'
      RETURNING id, user_id, status, returned_at, return_reason`,
    [actor.id, reason, recordId],
  );
  return rows[0] ?? null;
}

// 差し戻された記録を、本人が直して再度確定する。
// 時刻を直せるのは本人で、差し戻し中のときだけ
export async function resubmitRecord(recordId: number, userId: number, eventAt?: string) {
  const { rows } = await pool.query(
    `UPDATE attendance_records
        SET status = 'submitted',
            event_at = COALESCE($1::timestamptz, event_at),
            work_date = COALESCE(($1::timestamptz AT TIME ZONE 'Asia/Tokyo')::date, work_date),
            confirmed_at = now(),
            returned_at = NULL, returned_by = NULL, return_reason = NULL
      WHERE id = $2 AND user_id = $3 AND status = 'returned'
      RETURNING id, status, event_at, work_date`,
    [eventAt ?? null, recordId, userId],
  );
  return rows[0] ?? null;
}

export async function getRecord(recordId: number) {
  const { rows } = await pool.query(
    `SELECT id, user_id, kind, event_at, work_date, status FROM attendance_records WHERE id = $1`,
    [recordId],
  );
  return rows[0] ?? null;
}
