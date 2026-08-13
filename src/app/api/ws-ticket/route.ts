// WebSocket の入場券を配る。
//
// 誰が叩けるか: ログインしている人だけ（POST のみ）。
// 返すのは券と有効期限だけ。**利用者の情報は一切載せない**（email / role / manager_id を含めない）。
//
// 券に入れる sessionId は、**セッションの行の id（数字）**であって、
// セッショントークンそのものではない。
//   トークンを ws-server に渡すと、券が漏れたときにアプリのセッションごと奪われる。
//   行の id なら、券が漏れても「どのセッションか」を指すだけで、それ自体では何もできない。
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { currentActor, unauthorized, assertSameOrigin } from "@/lib/actor";
import { issueTicket, TICKET_TTL_SEC } from "@/lib/ws-ticket";

// Auth.js のセッションCookieの名前。本番（https）では __Secure- が付く
const COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"];

export async function POST(req: NextRequest) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;

  const actor = await currentActor();
  if (!actor) return unauthorized();

  const jar = await cookies();
  const token = COOKIE_NAMES.map((n) => jar.get(n)?.value).find((v) => v && v.length > 0);
  if (!token) return unauthorized();

  // セッションの行を引く。ここで期限も見る（切れているなら券を出さない）
  const { rows } = await pool.query(
    `SELECT id FROM sessions WHERE "sessionToken" = $1 AND expires > now()`,
    [token],
  );
  if (rows.length === 0) return unauthorized();

  const ticket = issueTicket(actor.id, String(rows[0].id));
  return NextResponse.json(
    { ticket, expiresIn: TICKET_TTL_SEC },
    { headers: { "Cache-Control": "no-store" } },
  );
}
