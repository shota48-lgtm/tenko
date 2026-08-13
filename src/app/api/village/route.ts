// 村に出すための、自分向けのまとめ。
//
// なぜ1本にまとめるか:
//   村は「未読があるか」「勤怠の下書きが残っているか」を同時に描く。
//   別々に叩くと、村の表示が2つの取得の間でちぐはぐになる。
//
// 誰の分を返すかは actor.ts が決める。**他人の分は返さない。**
//   未読も下書きも自分だけの情報であり、他人に配る理由がない（S4）。
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { currentActor, unauthorized } from "@/lib/actor";

export async function GET() {
  const actor = await currentActor();
  if (!actor) return unauthorized();
  const userId = actor.id;

  // 部屋ごとの未読件数。read_states が無い部屋は「全部が未読」ではなく、
  // 参加していない部屋まで数えないよう room_members にある部屋だけを見る
  const { rows: unread } = await pool.query(
    `SELECT m.room_id, count(*)::int AS n
       FROM messages m
       JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $1
       LEFT JOIN read_states rs ON rs.room_id = m.room_id AND rs.user_id = $1
      WHERE m.deleted_at IS NULL
        AND m.user_id <> $1
        AND m.id > COALESCE(rs.last_read_message_id, 0)
      GROUP BY m.room_id`,
    [userId],
  );

  // 未確定の勤怠の下書き。確定・却下は人が押すものなので、ここでは数えるだけ
  const { rows: drafts } = await pool.query(
    `SELECT id, kind, event_at, rule_id, matched_text
       FROM attendance_drafts
      WHERE user_id = $1 AND status = 'pending'
      ORDER BY event_at ASC`,
    [userId],
  );

  return NextResponse.json({
    unread: Object.fromEntries(unread.map((r) => [Number(r.room_id), Number(r.n)])),
    drafts: drafts.map((d) => ({
      id: Number(d.id),
      kind: d.kind,
      eventAt: d.event_at,
      ruleId: d.rule_id,
      matchedText: d.matched_text,
    })),
  });
}
