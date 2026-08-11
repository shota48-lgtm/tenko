// 下書きの確定・却下。人間が押したときだけ呼ばれる
import { NextRequest, NextResponse } from "next/server";
import { decideDraft } from "@/lib/drafts";
import { createRecordFromDraft } from "@/lib/approval";

const CURRENT_USER_ID = Number(process.env.TENKO_DEV_USER_ID ?? 1);

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const draftId = Number(id);
  if (!Number.isInteger(draftId) || draftId <= 0) {
    return NextResponse.json({ error: "id が不正です" }, { status: 400 });
  }
  let body: { action?: unknown; user?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON として読めません" }, { status: 400 }); }
  if (body.action !== "confirm" && body.action !== "reject") {
    return NextResponse.json({ error: "action は confirm か reject" }, { status: 400 });
  }
  const userId = Number(body.user ?? CURRENT_USER_ID);
  const row = await decideDraft(draftId, userId, body.action);
  if (!row) {
    return NextResponse.json({ error: "未確定の下書きが見つかりません（既に確定・却下済みの可能性）" }, { status: 409 });
  }

  // 本人が確定したら、上長の承認を待つ記録を作る。
  // 確定と承認は別の行為なので、ここではまだ勤怠として確定していない
  let record = null;
  if (body.action === "confirm") {
    try {
      record = await createRecordFromDraft(draftId);
    } catch (e) {
      console.error("[record] 承認待ち記録の作成に失敗: " + String(e));
    }
  }
  return NextResponse.json({ draft: row, record });
}