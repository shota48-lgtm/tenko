// 「誰がこのリクエストを出したか」を決める唯一の場所。
//
// Phase 5 段階3 で、リクエストのパラメータから受け取る形（S6の穴）を廃止した。
// 利用者はセッションからのみ決まる。
//
// **この関数は引数を取らない。**
//   リクエストから利用者IDを渡す経路を、構文の上で存在しなくするため。
//   「うっかり body.user を渡してしまう」ことが型の上でできない。
//
// **役割（role）もセッションからは取らない。** 毎回 users を引き直す。
//   セッションに載せた role は表示の分岐にしか使わない。
//   降格された人が、古いセッションのまま権限を持ち続けることを防ぐ。
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { pool } from "@/lib/db";

export type Role = "member" | "manager" | "admin";
export type Actor = {
  id: number;
  displayName: string;
  role: Role;
  managerId: number | null;
};

/** ログインしている人。ログインしていなければ null。判定はここだけで行う */
export async function currentActor(): Promise<Actor | null> {
  const session = await auth();
  // session.user.id は auth.ts で数値に直してある。ここでも念のため確かめる
  const id = Number(session?.user?.id ?? 0);
  if (!Number.isInteger(id) || id <= 0) return null;

  // セッション行が生きていても、削除された利用者は入れない。
  // 退職者を締め出す経路（users.deleted_at を入れるだけ）を有効にするため
  const { rows } = await pool.query(
    `SELECT id, display_name, role, manager_id, is_demo
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (rows.length === 0) return null;
  // デモ用の利用者にはログインの経路が無いが、万一セッションができても中には入れない
  if (rows[0].is_demo === true) return null;

  return {
    id: Number(rows[0].id),
    displayName: String(rows[0].display_name),
    role: rows[0].role as Role,
    managerId: rows[0].manager_id == null ? null : Number(rows[0].manager_id),
  };
}

/** 未ログインのときに返すもの。文面と状態コードを1か所に揃える */
export function unauthorized() {
  return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
}

/** 権限が足りないときに返すもの */
export function forbidden(reason = "権限がありません") {
  return NextResponse.json({ error: reason }, { status: 403 });
}

// 書き込みの経路で、他サイトから送られてきたリクエストを弾く（CSRF対策の2層目）。
//
// 1層目は Cookie の sameSite: lax で、他サイトからの POST には Cookie が送られない。
// それに頼らず、Origin が自分自身であることもここで確かめる。
// Origin が無いリクエスト（curl 等）は、ブラウザ発ではないので通す。
// ブラウザから送られる場合、書き込みメソッドには必ず Origin が付く。
export function assertSameOrigin(req: NextRequest): NextResponse | null {
  const origin = req.headers.get("origin");
  if (origin === null) return null;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return NextResponse.json({ error: "Origin が読めません" }, { status: 403 });
  }
  // Host は proxy を通っても NextRequest には正しく入る
  const self = req.headers.get("host");
  if (self !== null && host === self) return null;
  return NextResponse.json({ error: "別のサイトからの操作は受け付けません" }, { status: 403 });
}
