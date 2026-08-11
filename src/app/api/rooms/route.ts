// 部屋の一覧。村に建物を並べるために使う（読み取りのみ）
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export async function GET() {
  const { rows } = await pool.query(
    `SELECT id, name FROM rooms WHERE deleted_at IS NULL ORDER BY id ASC`,
  );
  return NextResponse.json({ rooms: rows.map((r) => ({ id: Number(r.id), name: r.name })) });
}
