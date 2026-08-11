// 勤怠の下書き。
//
// 設計方針（崩さないこと）:
//   - 立てるのは下書きまで。確定は必ず人間が押す。時間経過で確定しない
//   - 機械（検出）は INSERT しかしない。既存行を UPDATE しない
//   - 同じ発言・同じ種別からは1件しか立たない（DBの一意制約で保証）
import { pool } from "@/lib/db";
import { detect, type Detection } from "@/lib/attendance";

export type DraftRow = {
  id: number;
  user_id: number;
  message_id: number | null;
  kind: string;
  event_at: string;
  status: "pending" | "confirmed" | "rejected";
  rule_id: string;
  matched_text: string;
  source_body: string | null;
  created_at: string;
};

// 投稿が保存された後に呼ぶ。検出できなければ何もしない
export async function createDraftFromMessage(msg: {
  id: number; user_id: number; body: string; created_at: string | Date;
}): Promise<{ detection: Detection | null; created: boolean }> {
  const now = new Date(msg.created_at);
  const det = detect(msg.body, now);
  if (!det) return { detection: null, created: false };

  // ON CONFLICT DO NOTHING。再送や再処理で二重に立たない。
  // 却下済みの行が残っていても、同じ (message_id, kind) なので新しくは立たない
  const r = await pool.query(
    `INSERT INTO attendance_drafts
       (user_id, message_id, kind, event_at, status, rule_id, matched_text, source_body)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
     ON CONFLICT (message_id, kind) DO NOTHING
     RETURNING id`,
    [msg.user_id, msg.id, det.kind, det.eventAt.toISOString(), det.ruleId, det.matchedText, msg.body],
  );
  return { detection: det, created: r.rowCount === 1 };
}

export async function listDrafts(userId: number, status?: string) {
  const { rows } = await pool.query(
    `SELECT d.id, d.user_id, d.message_id, d.kind, d.event_at, d.status,
            d.rule_id, d.matched_text, d.source_body, d.created_at,
            m.deleted_at IS NOT NULL AS source_deleted
       FROM attendance_drafts d
       LEFT JOIN messages m ON m.id = d.message_id
      WHERE d.user_id = $1 AND ($2::text IS NULL OR d.status = $2)
      ORDER BY d.id DESC
      LIMIT 200`,
    [userId, status ?? null],
  );
  return rows;
}

// 人間が押したときだけ状態が変わる。pending 以外は変更しない
export async function decideDraft(id: number, userId: number, action: "confirm" | "reject") {
  const status = action === "confirm" ? "confirmed" : "rejected";
  const { rows } = await pool.query(
    `UPDATE attendance_drafts
        SET status = $1, decided_at = now(), decided_by = $2
      WHERE id = $3 AND user_id = $2 AND status = 'pending'
      RETURNING id, status, decided_at`,
    [status, userId, id],
  );
  return rows[0] ?? null;
}
