// 勤怠の修正申請。
//
// 設計方針（崩さないこと）:
//   - 承認済みの記録を書き換えない。修正は「新しい記録」として立て、元の記録を指す
//   - 承認の仕組みは Phase 4 のものをそのまま使う（status='submitted' で立て、上長が承認する）
//   - 新しい承認フローは作らない
//
// 誰が叩けるか:
//   POST: 自分の勤怠についてのみ申請できる。他人の記録を指した申請は 403
//   GET : 自分の申請と、自分が承認できる相手の申請
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { currentActor, unauthorized, assertSameOrigin } from "@/lib/actor";
import { TENKO_TZ } from "@/lib/notes";

const KINDS = ["arrive", "leave", "break", "late"];

export async function GET() {
  // 見える範囲は role と manager_id が決める。?user= は読まない（Phase 5 段階3）
  const actor = await currentActor();
  if (!actor) return unauthorized();

  const { rows } = await pool.query(
    `SELECT c.id, c.user_id, u.display_name, c.kind, c.event_at, c.work_date::text AS work_date,
            c.status, c.correction_reason, c.corrects_record_id, c.confirmed_at,
            o.kind AS original_kind, o.event_at AS original_event_at, o.status AS original_status
       FROM attendance_records c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN attendance_records o ON o.id = c.corrects_record_id
      WHERE c.corrects_record_id IS NOT NULL
        AND (c.user_id = $1
             OR $2 = 'admin'
             OR u.manager_id = $1)
      ORDER BY c.id DESC
      LIMIT 200`,
    [actor.id, actor.role],
  );
  return NextResponse.json({ actor: { id: actor.id, role: actor.role }, corrections: rows });
}

export async function POST(req: NextRequest) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  // 申請するのは自分の記録に対してだけ。誰として申請するかはセッションが決める
  const actor = await currentActor();
  if (!actor) return unauthorized();

  let body: { correctsRecordId?: unknown; kind?: unknown; eventAt?: unknown; reason?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON として読めません" }, { status: 400 }); }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length === 0) return NextResponse.json({ error: "修正の理由が必要です" }, { status: 400 });
  if (reason.length > 200) return NextResponse.json({ error: "理由は 200 文字までです" }, { status: 400 });

  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!KINDS.includes(kind)) return NextResponse.json({ error: "kind が不正です" }, { status: 400 });

  const eventAt = typeof body.eventAt === "string" ? body.eventAt : "";
  const parsed = new Date(eventAt);
  if (Number.isNaN(parsed.getTime())) return NextResponse.json({ error: "eventAt が日時として読めません" }, { status: 400 });

  // 元の記録を指す場合、それが自分のものであることを確認する。
  // 他人の記録を指した修正申請は作らせない（S4）
  let correctsId: number | null = null;
  if (body.correctsRecordId != null) {
    const n = Number(body.correctsRecordId);
    if (!Number.isInteger(n) || n <= 0) return NextResponse.json({ error: "correctsRecordId が不正です" }, { status: 400 });
    const { rows } = await pool.query(`SELECT id, user_id, kind FROM attendance_records WHERE id = $1`, [n]);
    if (rows.length === 0) return NextResponse.json({ error: "元の記録が見つかりません" }, { status: 404 });
    if (Number(rows[0].user_id) !== actor.id) {
      return NextResponse.json({ error: "自分の記録ではありません" }, { status: 403 });
    }
    // 種別が違うものを「修正」とは呼べない。
    // 出社の記録を退勤で差し替えると、元が月次から消えて別種の記録が増え、勤務時間が実態と合わなくなる
    // （審査役Cの指摘。実際に arrive を leave で差し替えられてしまった）
    if (rows[0].kind !== kind) {
      return NextResponse.json(
        { error: `元の記録は「${rows[0].kind}」です。種別の違う記録では修正できません（押し忘れの追加なら correctsRecordId を付けずに申請してください）` },
        { status: 400 },
      );
    }
    correctsId = n;
  }

  // 元の記録は書き換えない。新しい行として立てる
  const { rows } = await pool.query(
    `INSERT INTO attendance_records
       (user_id, draft_id, kind, event_at, work_date, status, confirmed_at, corrects_record_id, correction_reason)
     VALUES ($1, NULL, $2, $3::timestamptz, ($3::timestamptz AT TIME ZONE $4)::date, 'submitted', now(), $5, $6)
     RETURNING id, user_id, kind, event_at, work_date::text AS work_date, status, corrects_record_id, correction_reason`,
    [actor.id, kind, parsed.toISOString(), TENKO_TZ, correctsId, reason],
  );
  return NextResponse.json({ correction: rows[0] }, { status: 201 });
}
