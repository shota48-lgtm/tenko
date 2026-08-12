// デモ用の利用者の在席。
//
// なぜ要るか（設計書6節）:
//   村が空だと、見るだけで開いた人には何も伝わらない。
//   かといってデモ用のプロセスを常時動かすと、Railway の枠を消費し、
//   そのプロセスが落ちた瞬間に村が空になる。
//   **接続を持たずに村にいる人**を、DBの行として持つ。
//
// ws-server がこれを60秒ごとに取りに来て、実際の接続に足して配る。
// 返すのは村の絵に要るものだけ（位置・状態・話しかけ可否）。勤怠も役割も返さない。
import { NextResponse } from "next/server";
import { allowPublic, demoPresence } from "@/lib/public-view";

export async function GET() {
  const stop = await allowPublic();
  if (stop) return stop;
  return NextResponse.json({ demo: await demoPresence() });
}
