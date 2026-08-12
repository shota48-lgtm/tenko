// 見るだけモード（未ログインでも村が見える）の分岐を、ここ1か所に集める。
//
// なぜ1か所か:
//   「どこまで公開しているか」が散らばると、後から見て分からなくなる。
//   実運用では「うちの社員が今日何をしているか」が外から見えるのは問題になりうるため、
//   1つの環境変数で確実に止められる必要がある（設計書4節）。
//
// 既定は有効（1）。無効にするには TENKO_PUBLIC_VIEW=0。
//
// 無効にしたときの見え方（2026-08-13 に決めた）:
//   村そのものを見せない。未ログインは /login だけが見える状態にする。
//   「建物だけ見える」のような中途半端な状態は作らない。
//   何が公開されているかが分からなくなり、確認もできなくなるため。
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { currentActor } from "@/lib/actor";

export const PUBLIC_VIEW = (process.env.TENKO_PUBLIC_VIEW ?? "1") === "1";

/**
 * 未ログインでも読める経路の入口。
 * 見るだけモードが有効ならそのまま通す。無効ならログインを要求する。
 * **開放する経路は、必ずこの関数を通すこと**（verify-auth-coverage.js が検査する）。
 */
export async function allowPublic(): Promise<NextResponse | null> {
  if (PUBLIC_VIEW) return null;
  // 無効のときは、ログインしている人にだけ返す
  const actor = await currentActor();
  if (actor) return null;
  return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
}

/**
 * 村に出す利用者の一覧。
 *
 * ログインしている人には全員の表示名を返す（村で誰が誰か分かる必要がある）。
 * **未ログインの人にはデモ用の利用者の表示名だけを返す。**
 *   実在の利用者の名前を、村を見ただけの人に配らない。
 *   「今日やること」をデモ用だけに絞る判断（POの判断）と同じ考え方を、名前にも当てる。
 *   結果として、未ログインの画面では実在の人は名前のないアバターとして見える。
 */
export async function usersFor(loggedIn: boolean) {
  const { rows } = await pool.query(
    loggedIn
      ? `SELECT id, display_name, is_demo FROM users WHERE deleted_at IS NULL ORDER BY id ASC`
      : `SELECT id, display_name, is_demo FROM users WHERE deleted_at IS NULL AND is_demo = true ORDER BY id ASC`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    displayName: r.display_name,
    // 画面で「この人はデモ用」と示すために使う（呼びかけ・チャットの案内を変える）
    isDemo: r.is_demo === true,
  }));
}

/**
 * デモ用の利用者の在席。接続が無くても村にいる人。
 * ws-server がこれを取りに来て、実際の接続に足して配る。
 */
export async function demoPresence() {
  const { rows } = await pool.query(
    `SELECT d.user_id, d.state, d.talk, d.room_id, d.x, d.y, d.color_index
       FROM demo_presence d
       JOIN users u ON u.id = d.user_id AND u.deleted_at IS NULL AND u.is_demo = true
      ORDER BY d.user_id`,
  );
  return rows.map((r) => ({
    id: Number(r.user_id),
    state: r.state,
    talk: r.talk,
    roomId: r.room_id == null ? null : Number(r.room_id),
    x: Number(r.x),
    y: Number(r.y),
    colorIndex: Number(r.color_index),
  }));
}
