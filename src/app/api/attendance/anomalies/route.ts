// 勤怠異常の提示。
//
// 誰が叩けるか:
//   member  : 自分の分だけ
//   manager : 自分と、自分が manager_id に指定されている部下の分
//   admin   : 全員
// 対象の絞り込みはSQL側で行う。user を指定して他人の分だけを取ることはできない。
// 自動修正は一切しない。読み取りのみ。
import { NextRequest, NextResponse } from "next/server";
import { getActor } from "@/lib/approval";
import { requestedUserId } from "@/lib/actor";
import { findAnomalies, targetUserIds, ANOMALY_LABEL, LONG_WORK_HOURS, ANOMALY_DAYS } from "@/lib/anomaly";

export async function GET(req: NextRequest) {
  const actorId = requestedUserId(req.nextUrl.searchParams.get("user"));
  if (actorId <= 0) return NextResponse.json({ error: "利用者が見つかりません" }, { status: 401 });
  const actor = await getActor(actorId);
  if (!actor) return NextResponse.json({ error: "利用者が見つかりません" }, { status: 401 });

  const ids = await targetUserIds(actor.id, actor.role);

  // 特定の相手だけを見たい場合も、見てよい相手の集合との積を取る。
  // 集合の外を指定しても、他人のデータは出ない
  const focus = req.nextUrl.searchParams.get("target");
  let scope = ids;
  if (focus !== null) {
    const n = Number(focus);
    scope = ids.filter((id) => id === n);
    if (scope.length === 0) {
      return NextResponse.json({ error: "この利用者の勤怠を見る権限がありません" }, { status: 403 });
    }
  }

  const anomalies = await findAnomalies(scope);
  return NextResponse.json({
    actor,
    scope,
    thresholds: { longWorkHours: LONG_WORK_HOURS, days: ANOMALY_DAYS },
    labels: ANOMALY_LABEL,
    anomalies,
  });
}
