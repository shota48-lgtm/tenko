// 自分の勤怠の下書き一覧
import { NextRequest, NextResponse } from "next/server";
import { currentActor, unauthorized } from "@/lib/actor";
import { listDrafts } from "@/lib/drafts";


export async function GET(req: NextRequest) {
  // 返すのは自分の分だけ。?user= は読まない（Phase 5 段階3）
  const actor = await currentActor();
  if (!actor) return unauthorized();

  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  if (status && !["pending", "confirmed", "rejected"].includes(status)) {
    return NextResponse.json({ error: "status が不正です" }, { status: 400 });
  }
  const drafts = await listDrafts(actor.id, status);
  return NextResponse.json({ drafts });
}
