// 村の噴水に出すお知らせ。
//
// 権限（S3）:
//   - 読むのは全員。書く・消すのは **admin のみ**
//   - 役割はリクエストの値を信じず、毎回DBから引き直す
//   - 画面でボタンを隠すことは権限の担保にならない。ここで弾く
//
// 入力（S1）:
//   - 本文はサーバー側で検証する。制御文字を落とし、長さを切る（notes.ts と同じ考え方）
//   - 画面には React のエスケープを通して出す。dangerouslySetInnerHTML は使わない
//
// 消し方:
//   行は消さず deleted_at を入れる。誰が何を出したかを後から追えるようにするため。
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { currentActor, unauthorized, forbidden, assertSameOrigin } from "@/lib/actor";
import { sanitizeNote } from "@/lib/notes";

const BODY_MAX = 200;

// 誰がこのリクエストを出したか、その役割は何かは currentActor() が決める（Phase 5 段階3）。
// セッションから引き、役割は毎回 users を引き直す。?user= も body.user も読まない

export async function GET() {
  const me = await currentActor();
  if (!me) return unauthorized();

  const { rows } = await pool.query(
    `SELECT a.id, a.body, a.created_at, u.display_name
       FROM announcements a JOIN users u ON u.id = a.user_id
      WHERE a.deleted_at IS NULL
      ORDER BY a.id DESC
      LIMIT 20`,
  );
  const { rows: read } = await pool.query(
    `SELECT last_read_announcement_id FROM announcement_reads WHERE user_id = $1`,
    [me.id],
  );
  const lastRead = read.length ? Number(read[0].last_read_announcement_id) : 0;

  return NextResponse.json({
    // 書ける人かどうかは画面の見せ方に使うだけ。書けるかどうかの判定は POST 側で行う
    canWrite: me.role === "admin",
    lastRead,
    unread: rows.filter((r) => Number(r.id) > lastRead).length,
    announcements: rows.map((r) => ({
      id: Number(r.id),
      body: r.body,
      displayName: r.display_name,
      createdAt: r.created_at,
    })),
  });
}

export async function POST(req: NextRequest) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const me = await currentActor();
  if (!me) return unauthorized();
  if (me.role !== "admin") return forbidden("お知らせを書けるのは管理者のみです");
  const raw = await req.json().catch(() => ({}));
  // 検証は notes.ts と同じものを使う。制御文字・双方向制御・ゼロ幅は落ちる
  const clean = sanitizeNote(raw.body, BODY_MAX);
  if (!clean.ok) {
    return NextResponse.json({ error: clean.reason }, { status: 400 });
  }
  const body = clean.body;
  const { rows } = await pool.query(
    `INSERT INTO announcements (user_id, body) VALUES ($1, $2) RETURNING id, body, created_at`,
    [me.id, body],
  );
  return NextResponse.json({ announcement: { id: Number(rows[0].id), body: rows[0].body } }, { status: 201 });
}

// 既読にする。自分の分だけ。誰の分を更新するかはサーバーが決める
export async function PUT(req: NextRequest) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const me = await currentActor();
  if (!me) return unauthorized();

  const { rows } = await pool.query(
    `SELECT COALESCE(max(id), 0) AS last FROM announcements WHERE deleted_at IS NULL`,
  );
  await pool.query(
    `INSERT INTO announcement_reads (user_id, last_read_announcement_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET last_read_announcement_id = GREATEST(announcement_reads.last_read_announcement_id, EXCLUDED.last_read_announcement_id),
           updated_at = now()`,
    [me.id, Number(rows[0].last)],
  );
  return NextResponse.json({ lastRead: Number(rows[0].last) });
}

// 消す。admin のみ。行は残し、消した印を付ける
export async function DELETE(req: NextRequest) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const me = await currentActor();
  if (!me) return unauthorized();
  if (me.role !== "admin") return forbidden("お知らせを消せるのは管理者のみです");
  const raw = await req.json().catch(() => ({}));
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "id が不正です" }, { status: 400 });
  }
  const { rowCount } = await pool.query(
    `UPDATE announcements SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return NextResponse.json({ deleted: rowCount });
}
