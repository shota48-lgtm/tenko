// 投稿の保存(POST)と差分取得(GET)
//
// 設計方針（spike/ws-01 の実測にもとづき固定。崩さないこと）:
//   - 投稿は必ずここ（HTTP）で受け取り DB に保存する。WebSocket 経由では保存しない
//   - WebSocket への通知は、保存が成功した後にのみ行う
//   - 通知の失敗は保存の失敗ではない。通知が落ちても 201 を返す
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { notifyNewMessage } from "@/lib/notify";
import { createDraftFromMessage } from "@/lib/drafts";

// 認証は Phase 1 の範囲外。利用者は暫定的に固定値で扱う
const CURRENT_USER_ID = Number(process.env.TENKO_DEV_USER_ID ?? 1);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ roomId: string }> };

// GET /api/rooms/:roomId/messages?after=<id>&limit=<n>
// after より後の投稿を古い順に返す。再接続したクライアントが差分を埋めるための経路
export async function GET(req: NextRequest, { params }: Ctx) {
  const { roomId } = await params;
  const roomIdNum = Number(roomId);
  if (!Number.isInteger(roomIdNum) || roomIdNum <= 0) {
    return NextResponse.json({ error: "roomId が不正です" }, { status: 400 });
  }

  const after = Number(req.nextUrl.searchParams.get("after") ?? 0);
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 200), 500);
  if (!Number.isFinite(after) || after < 0) {
    return NextResponse.json({ error: "after が不正です" }, { status: 400 });
  }

  // deleted_at が入った投稿も返す。本文は伏せ、deleted フラグで表す。
  // 行ごと除外すると、削除された投稿の id を最後に受け取ったクライアントが
  // after=<その id> で永久に取りこぼす（穴が空いたことに気づけない）ため。
  const { rows } = await pool.query(
    `SELECT m.id,
            m.room_id,
            m.user_id,
            u.display_name,
            m.client_msg_id,
            CASE WHEN m.deleted_at IS NULL THEN m.body ELSE NULL END AS body,
            (m.deleted_at IS NOT NULL) AS deleted,
            m.created_at,
            m.edited_at
       FROM messages m
       JOIN users u ON u.id = m.user_id
      WHERE m.room_id = $1 AND m.id > $2
      ORDER BY m.id ASC
      LIMIT $3`,
    [roomIdNum, after, limit],
  );

  return NextResponse.json({
    messages: rows,
    lastId: rows.length > 0 ? Number(rows[rows.length - 1].id) : after,
  });
}

// POST /api/rooms/:roomId/messages
// body: { clientMsgId: uuid, body: string }
export async function POST(req: NextRequest, { params }: Ctx) {
  const { roomId } = await params;
  const roomIdNum = Number(roomId);
  if (!Number.isInteger(roomIdNum) || roomIdNum <= 0) {
    return NextResponse.json({ error: "roomId が不正です" }, { status: 400 });
  }

  let payload: { clientMsgId?: unknown; body?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON として読めません" }, { status: 400 });
  }

  const clientMsgId = payload.clientMsgId;
  const body = payload.body;
  if (typeof clientMsgId !== "string" || !UUID_RE.test(clientMsgId)) {
    return NextResponse.json({ error: "clientMsgId は UUID の文字列で必要です" }, { status: 400 });
  }
  if (typeof body !== "string" || body.length < 1 || body.length > 4000) {
    return NextResponse.json({ error: "body は 1〜4000 文字の文字列で必要です" }, { status: 400 });
  }

  // 再送されても DB の一意制約が 1 件しか通さない。
  // 挿入できなかった場合は既存行を読み直して返し、新規と区別できるようにする。
  const inserted = await pool.query(
    `INSERT INTO messages (room_id, user_id, client_msg_id, body)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, client_msg_id) DO NOTHING
     RETURNING id, room_id, user_id, client_msg_id, body, created_at`,
    [roomIdNum, CURRENT_USER_ID, clientMsgId, body],
  );

  let row = inserted.rows[0];
  const isNew = inserted.rowCount === 1;

  if (!isNew) {
    const existing = await pool.query(
      `SELECT id, room_id, user_id, client_msg_id, body, created_at
         FROM messages
        WHERE user_id = $1 AND client_msg_id = $2`,
      [CURRENT_USER_ID, clientMsgId],
    );
    row = existing.rows[0];
    if (!row) {
      return NextResponse.json({ error: "保存にも既存行の取得にも失敗しました" }, { status: 500 });
    }
  }

  // ここから先は通知と勤怠の下書き。保存はすでに確定している
  let notified = false;
  let notifyError: string | undefined;
  let draft: { kind: string; eventAt: string; ruleId: string; created: boolean } | null = null;
  if (isNew) {
    const r = await notifyNewMessage({ type: "message.created", message: row });
    notified = r.delivered;
    notifyError = r.error;

    // 発言から勤怠の下書きを立てる。検出できなければ何もしない。
    // 下書きの作成に失敗しても投稿の保存は取り消さない（保存は既に確定している）
    try {
      const d = await createDraftFromMessage({
        id: Number(row.id), user_id: Number(row.user_id), body: row.body, created_at: row.created_at,
      });
      if (d.detection) {
        draft = {
          kind: d.detection.kind,
          eventAt: d.detection.eventAt.toISOString(),
          ruleId: d.detection.ruleId,
          created: d.created,
        };
      }
    } catch (e) {
      console.error("[draft] 下書きの作成に失敗: " + String(e));
    }
  }

  return NextResponse.json(
    { duplicate: !isNew, message: row, notified, notifyError, draft },
    { status: isNew ? 201 : 200 },
  );
}