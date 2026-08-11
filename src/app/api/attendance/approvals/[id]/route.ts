// 承認・差し戻し・再提出。
//
// 権限の検証はここで行う。画面を隠すだけでは、このAPIを直接叩かれれば通ってしまう。
import { NextRequest, NextResponse } from "next/server";
import { getActor, canApprove, getRecord, approveRecord, returnRecord, resubmitRecord } from "@/lib/approval";

const CURRENT_USER_ID = Number(process.env.TENKO_DEV_USER_ID ?? 1);

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const recordId = Number(id);
  if (!Number.isInteger(recordId) || recordId <= 0) {
    return NextResponse.json({ error: "id が不正です" }, { status: 400 });
  }

  let body: { action?: unknown; reason?: unknown; user?: unknown; eventAt?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON として読めません" }, { status: 400 }); }

  const action = body.action;
  if (action !== "approve" && action !== "return" && action !== "resubmit") {
    return NextResponse.json({ error: "action は approve / return / resubmit のいずれか" }, { status: 400 });
  }

  const actor = await getActor(Number(body.user ?? CURRENT_USER_ID));
  if (!actor) return NextResponse.json({ error: "利用者が見つかりません" }, { status: 401 });

  const record = await getRecord(recordId);
  if (!record) return NextResponse.json({ error: "記録が見つかりません" }, { status: 404 });

  // 本人が差し戻しを直して再提出する経路。承認の権限は要らないが、本人であることは必要
  if (action === "resubmit") {
    if (Number(record.user_id) !== actor.id) {
      return NextResponse.json({ error: "自分の記録ではありません" }, { status: 403 });
    }
    const eventAt = typeof body.eventAt === "string" ? body.eventAt : undefined;
    const row = await resubmitRecord(recordId, actor.id, eventAt);
    if (!row) return NextResponse.json({ error: "差し戻し中の記録ではありません" }, { status: 409 });
    return NextResponse.json({ record: row });
  }

  // ここから先は承認の権限が要る
  const permit = await canApprove(actor, Number(record.user_id));
  if (!permit.ok) {
    return NextResponse.json({ error: permit.reason ?? "承認する権限がありません" }, { status: 403 });
  }

  if (action === "approve") {
    const row = await approveRecord(recordId, actor);
    if (!row) return NextResponse.json({ error: "承認待ちの記録ではありません" }, { status: 409 });
    return NextResponse.json({ record: row });
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length === 0) {
    return NextResponse.json({ error: "差し戻しには理由が必要です" }, { status: 400 });
  }
  const row = await returnRecord(recordId, actor, reason);
  if (!row) return NextResponse.json({ error: "承認待ちの記録ではありません" }, { status: 409 });
  return NextResponse.json({ record: row });
}
