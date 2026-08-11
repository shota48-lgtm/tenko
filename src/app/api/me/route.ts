// 自分自身の情報（表示名と役割）。
//
// なぜ /api/users と分けるか:
//   役割（member / manager / admin）は組織の構造そのもので、全員に配る必要がない。
//   村の一覧に必要なのは表示名だけなので、/api/users は表示名しか返さない。
//   「承認画面への導線を出すか」の判断にだけ役割が要るため、自分の分だけをここで返す。
//
// 誰の分を返すかは actor.ts が決める。リクエストの user を信じるかどうかも同様
// （TENKO_TRUST_USER_PARAM=0 ならサーバー側の固定値だけを使う）。
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { requestedUserId } from "@/lib/actor";

export async function GET(req: NextRequest) {
  const id = requestedUserId(req.nextUrl.searchParams.get("user"));
  const { rows } = await pool.query(
    `SELECT id, display_name, role FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: "利用者が見つかりません" }, { status: 401 });
  }
  const r = rows[0];
  return NextResponse.json({
    me: { id: Number(r.id), displayName: r.display_name, role: r.role },
  });
}
