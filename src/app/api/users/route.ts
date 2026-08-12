// 村の一覧に出す利用者。
//
// 誰が叩けるか（Phase 5 段階4）:
//   ログインしている人 : 全員の表示名。村で誰が誰か分かる必要がある
//   未ログインの人     : **デモ用の利用者の表示名だけ**
//
// 返すのは表示名だけで、役割・上長・勤怠・メールアドレスは返さない。
// 絞り込みの規則は public-view.ts に集めてある（見るだけモードの分岐を散らさない）。
import { NextResponse } from "next/server";
import { currentActor } from "@/lib/actor";
import { allowPublic, usersFor } from "@/lib/public-view";

export async function GET() {
  const actor = await currentActor();
  if (!actor) {
    const stop = await allowPublic();
    if (stop) return stop;
  }
  return NextResponse.json({ users: await usersFor(actor !== null) });
}
