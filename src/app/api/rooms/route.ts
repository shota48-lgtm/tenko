// 部屋の一覧。村に建物を並べるために使う（読み取りのみ）
// kind は建物の種別（room = house / hall = 共有の建物）。並び順では決めない
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export async function GET() {
  const { rows } = await pool.query(
    `SELECT id, name, kind, capacity, deco FROM rooms WHERE deleted_at IS NULL ORDER BY id ASC`,
  );
  return NextResponse.json({
    rooms: rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      kind: r.kind === "hall" ? "hall" : "room",
      // 定員。運用で変わるためDBの列から取る（Phase 4.8）
      capacity: Number(r.capacity),
      // 屋根の印。部屋名からは推測しない（Phase 4.10）
      deco: r.deco,
    })),
  });
}
