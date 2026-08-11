// 自分の勤怠の下書き一覧
import { NextRequest, NextResponse } from "next/server";
import { listDrafts } from "@/lib/drafts";

const CURRENT_USER_ID = Number(process.env.TENKO_DEV_USER_ID ?? 1);

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  if (status && !["pending", "confirmed", "rejected"].includes(status)) {
    return NextResponse.json({ error: "status が不正です" }, { status: 400 });
  }
  const userId = Number(req.nextUrl.searchParams.get("user") ?? CURRENT_USER_ID);
  const drafts = await listDrafts(userId, status);
  return NextResponse.json({ drafts });
}
