// 承認待ちの一覧。誰が見られるかは role と manager_id で決まる（画面側では判定しない）
import { NextResponse } from "next/server";
import { currentActor, unauthorized, forbidden } from "@/lib/actor";
import { listPendingApprovals } from "@/lib/approval";


export async function GET() {
  // 役割はセッションからではなく users から引き直す（currentActor がそうしている）。
  // ?user= は読まない（Phase 5 段階3）
  const actor = await currentActor();
  if (!actor) return unauthorized();
  if (actor.role === "member") return forbidden("承認の一覧を見る権限がありません");

  const items = await listPendingApprovals({ id: actor.id, role: actor.role });
  return NextResponse.json({ actor: { id: actor.id, role: actor.role }, items });
}
