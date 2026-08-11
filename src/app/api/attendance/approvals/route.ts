// 承認待ちの一覧。誰が見られるかは role と manager_id で決まる（画面側では判定しない）
import { NextRequest, NextResponse } from "next/server";
import { requestedUserId } from "@/lib/actor";
import { getActor, listPendingApprovals } from "@/lib/approval";


export async function GET(req: NextRequest) {
  const userId = requestedUserId(req.nextUrl.searchParams.get("user"));
  const actor = await getActor(userId);
  if (!actor) return NextResponse.json({ error: "利用者が見つかりません" }, { status: 401 });
  if (actor.role === "member") {
    return NextResponse.json({ error: "承認の一覧を見る権限がありません" }, { status: 403 });
  }
  const items = await listPendingApprovals(actor);
  return NextResponse.json({ actor, items });
}
