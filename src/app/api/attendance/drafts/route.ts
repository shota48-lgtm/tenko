// 自分の勤怠の下書き一覧
import { NextRequest, NextResponse } from "next/server";
import { requestedUserId } from "@/lib/actor";
import { listDrafts } from "@/lib/drafts";


export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  if (status && !["pending", "confirmed", "rejected"].includes(status)) {
    return NextResponse.json({ error: "status が不正です" }, { status: 400 });
  }
  const userId = requestedUserId(req.nextUrl.searchParams.get("user"));
  const drafts = await listDrafts(userId, status);
  return NextResponse.json({ drafts });
}
