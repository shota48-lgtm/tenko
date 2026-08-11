// 承認待ちの一覧。誰が見られるかは role と manager_id で決まる（画面側では判定しない）
import { NextRequest, NextResponse } from "next/server";
import { getActor, listPendingApprovals } from "@/lib/approval";

const CURRENT_USER_ID = Number(process.env.TENKO_DEV_USER_ID ?? 1);

export async function GET(req: NextRequest) {
  const userId = Number(req.nextUrl.searchParams.get("user") ?? CURRENT_USER_ID);
  const actor = await getActor(userId);
  if (!actor) return NextResponse.json({ error: "利用者が見つかりません" }, { status: 401 });
  if (actor.role === "member") {
    return NextResponse.json({ error: "承認の一覧を見る権限がありません" }, { status: 403 });
  }
  const items = await listPendingApprovals(actor);
  return NextResponse.json({ actor, items });
}
