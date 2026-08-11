// 村の一覧に出す利用者。
//
// 誰が叩けるか: 誰でも。返すのは表示名だけで、役割・上長・勤怠は返さない。
// 表示名は在席の配信（WebSocket）で既に全員に見えている情報であり、ここで増えるものはない。
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export async function GET() {
  const { rows } = await pool.query(
    `SELECT id, display_name FROM users WHERE deleted_at IS NULL ORDER BY id ASC`,
  );
  return NextResponse.json({
    users: rows.map((r) => ({ id: Number(r.id), displayName: r.display_name })),
  });
}
