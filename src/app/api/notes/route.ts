// 「今日やること」のAPI。
//
// 誰が叩けるか:
//   GET  : 誰でも。返すのは「今日の分」だけで、村にいる全員に見える前提の情報
//   PUT  : 自分の分だけ。書き込み先の user_id はリクエストの値をそのまま使わず、
//          利用者が実在することをDBで確認してから使う（認証導入時はここを差し替える）
//   DELETE: 自分の分だけ
//
// 日付はサーバーが決める。リクエストから日付を受け取る口は作らない。
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { sanitizeNote, upsertTodayNote, deleteTodayNote, listTodayNotes, getTodayNote, NOTE_MAX } from "@/lib/notes";
import { requestedUserId } from "@/lib/actor";

// 誰として扱うかは @/lib/actor が決める（認証導入時はそこだけを差し替える。S6）。
// ここでは、その利用者が実在するかをDBで確認する
async function resolveUser(raw: unknown): Promise<number | null> {
  const id = requestedUserId(raw);
  if (id <= 0) return null;
  const { rows } = await pool.query(`SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows.length === 1 ? Number(rows[0].id) : null;
}

export async function GET(req: NextRequest) {
  const who = req.nextUrl.searchParams.get("user");
  if (who === null) {
    return NextResponse.json({ notes: await listTodayNotes(), max: NOTE_MAX });
  }
  const userId = await resolveUser(who);
  if (userId === null) return NextResponse.json({ error: "利用者が見つかりません" }, { status: 404 });
  return NextResponse.json({ note: await getTodayNote(userId), max: NOTE_MAX });
}

export async function PUT(req: NextRequest) {
  let payload: { body?: unknown; user?: unknown };
  try { payload = await req.json(); } catch { return NextResponse.json({ error: "JSON として読めません" }, { status: 400 }); }

  const userId = await resolveUser(payload.user);
  if (userId === null) return NextResponse.json({ error: "利用者が見つかりません" }, { status: 401 });

  const s = sanitizeNote(payload.body);
  if (!s.ok) return NextResponse.json({ error: s.reason }, { status: 400 });

  const row = await upsertTodayNote(userId, s.body);
  return NextResponse.json({ note: { user_id: Number(row.user_id), body: row.body, updated_at: row.updated_at } });
}

export async function DELETE(req: NextRequest) {
  let payload: { user?: unknown } = {};
  try { payload = await req.json(); } catch { /* 本文なしも許す */ }
  const userId = await resolveUser(payload.user);
  if (userId === null) return NextResponse.json({ error: "利用者が見つかりません" }, { status: 401 });
  const n = await deleteTodayNote(userId);
  return NextResponse.json({ deleted: n });
}
