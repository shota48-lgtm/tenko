// 自分自身の情報（表示名と役割）。
//
// なぜ /api/users と分けるか:
//   役割（member / manager / admin）は組織の構造そのもので、全員に配る必要がない。
//   村の一覧に必要なのは表示名だけなので、/api/users は表示名しか返さない。
//   「承認画面への導線を出すか」の判断にだけ役割が要るため、自分の分だけをここで返す。
//
// 誰の分を返すかはセッションだけが決める（Phase 5 段階3）。
// リクエストの ?user= は読まない。読む経路が存在しない
import { NextResponse } from "next/server";
import { currentActor, unauthorized } from "@/lib/actor";

export async function GET() {
  const actor = await currentActor();
  if (!actor) return unauthorized();
  return NextResponse.json({
    me: { id: actor.id, displayName: actor.displayName, role: actor.role },
  });
}
