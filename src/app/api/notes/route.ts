// 「今日やること」のAPI。
//
// 誰が叩けるか（Phase 5 段階3）:
//   GET （全員分）: 誰でも。村の吹き出しに使う。**段階4でデモ用の利用者の分だけに絞る**
//   GET （自分の）: ログインした人だけ。返すのは自分の分だけ（?user= は読まない）
//   PUT / DELETE  : ログインした人だけ。書き込み先はセッションの人に固定する
//
// 日付はサーバーが決める。リクエストから日付を受け取る口は作らない。
import { NextRequest, NextResponse } from "next/server";
import { sanitizeNote, upsertTodayNote, deleteTodayNote, listTodayNotes, listDemoNotes, getTodayNote, NOTE_MAX } from "@/lib/notes";
import { currentActor, unauthorized, assertSameOrigin } from "@/lib/actor";
import { allowPublic } from "@/lib/public-view";

// `?mine=1` が付いていれば自分の分。付いていなければ村に出す一覧。
//
// 一覧は誰が見るかで中身が変わる（Phase 5 段階4。POの判断）:
//   ログインしている人 : 全員分
//   未ログインの人     : **デモ用の利用者の分だけ**
//     実在の利用者が書いた業務内容を、村を見ただけの人に見せない
export async function GET(req: NextRequest) {
  const actor = await currentActor();

  if (req.nextUrl.searchParams.get("mine") !== "1") {
    if (!actor) {
      const stop = await allowPublic();
      if (stop) return stop;
      return NextResponse.json({ notes: await listDemoNotes(), max: NOTE_MAX });
    }
    return NextResponse.json({ notes: await listTodayNotes(), max: NOTE_MAX });
  }

  if (!actor) return unauthorized();
  return NextResponse.json({ note: await getTodayNote(actor.id), max: NOTE_MAX });
}

export async function PUT(req: NextRequest) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const actor = await currentActor();
  if (!actor) return unauthorized();

  let payload: { body?: unknown };
  try { payload = await req.json(); } catch { return NextResponse.json({ error: "JSON として読めません" }, { status: 400 }); }

  const s = sanitizeNote(payload.body);
  if (!s.ok) return NextResponse.json({ error: s.reason }, { status: 400 });

  // 書き込み先はセッションの人。本文に user が入っていても読まない
  const row = await upsertTodayNote(actor.id, s.body);
  return NextResponse.json({ note: { user_id: Number(row.user_id), body: row.body, updated_at: row.updated_at } });
}

export async function DELETE(req: NextRequest) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const actor = await currentActor();
  if (!actor) return unauthorized();
  const n = await deleteTodayNote(actor.id);
  return NextResponse.json({ deleted: n });
}
