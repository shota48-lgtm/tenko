// ws-server からの定期確認。「このセッションはまだ生きているか」だけを答える。
//
// 誰が叩けるか: 共有秘密（TENKO_WS_INTERNAL_TOKEN）を持つ者だけ。利用者のセッションではない。
//   ws-server はサーバ同士の通信なので、Cookie は無い。
//
// なぜ ws-server にDBを引かせないか（設計書6節）:
//   Railway 側にDBの資格情報を置かずに済む。漏洩面が1つ減る。
//
// **`/api/demo-presence` とは1本にまとめない。**
//   周期は同じでも、失敗したときの扱いが逆であるため（PO判断）:
//     demo-presence の失敗 → 前回の内容を使い続ける（村が空にならないように）
//     ws-verify の失敗     → 段階的に切断する（無効化の仕組みが死んだままにならないように）
//   まとめると、片方の障害がもう片方を巻き込む。
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";

export async function POST(req: NextRequest) {
  const expected = process.env.TENKO_WS_INTERNAL_TOKEN;
  if (!expected || expected.length === 0) {
    // 共有秘密が設定されていないなら、この経路は開けない。
    // 「設定が無いから素通し」にはしない
    return NextResponse.json({ error: "設定されていません" }, { status: 503 });
  }
  if (req.headers.get("x-tenko-internal") !== expected) {
    return NextResponse.json({ error: "権限がありません" }, { status: 401 });
  }

  let body: { sessionIds?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON として読めません" }, { status: 400 }); }

  const ids = Array.isArray(body.sessionIds)
    ? body.sessionIds.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500)
    : [];
  if (ids.length === 0) return NextResponse.json({ valid: [], invalid: [] });

  // 生きている条件: セッションの行があり、期限内で、利用者が削除されていない。
  // デモ用の利用者はそもそもログインできないが、ここでも弾いておく
  const { rows } = await pool.query(
    `SELECT s.id
       FROM sessions s
       JOIN users u ON u.id = s."userId"
      WHERE s.id = ANY($1) AND s.expires > now()
        AND u.deleted_at IS NULL AND u.is_demo = false`,
    [ids],
  );
  const valid = rows.map((r) => Number(r.id));
  const invalid = ids.filter((id) => !valid.includes(id));
  return NextResponse.json({ valid, invalid });
}
