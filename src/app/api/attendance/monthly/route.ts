// 月次の勤怠記録。CSV で返す。
// 自分の記録か、自分が承認できる相手の記録だけを出す（判定は API 側で行う）
import { NextRequest, NextResponse } from "next/server";
import { requestedUserId } from "@/lib/actor";
import { getActor, canApprove } from "@/lib/approval";
import { monthly, toCsv } from "@/lib/monthly";


export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const actorId = requestedUserId(q.get("actor"));
  const targetId = Number(q.get("user") ?? actorId);
  const year = Number(q.get("year"));
  const month = Number(q.get("month"));
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: "year と month が必要です" }, { status: 400 });
  }

  const actor = await getActor(actorId);
  if (!actor) return NextResponse.json({ error: "利用者が見つかりません" }, { status: 401 });

  if (actor.id !== targetId) {
    const permit = await canApprove(actor, targetId);
    if (!permit.ok) {
      return NextResponse.json({ error: permit.reason ?? "他人の勤怠を見る権限がありません" }, { status: 403 });
    }
  }

  const m = await monthly(targetId, year, month);
  if (!m) return NextResponse.json({ error: "対象の利用者が見つかりません" }, { status: 404 });

  if (q.get("format") === "json") return NextResponse.json(m);

  const name = `tenko-${targetId}-${year}${String(month).padStart(2, "0")}.csv`;
  // Excel で開いたときに文字化けしないよう BOM を付ける
  return new NextResponse("﻿" + toCsv(m), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}
