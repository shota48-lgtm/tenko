// 村の入口。
//
// ここはサーバー側で動く。部屋の一覧（＝建物の配置と定員）をDBから読み、
// 画面側に渡してから描かせる。
//
// なぜそうするか:
//   画面側で /api/rooms を取りに行っていたところ、到着まで約1.4秒かかり（実測）、
//   その間は「地面・装飾・噴水・人物はあるのに建物だけ無い村」が描かれていた。
//   建物の配置は村の骨組みなので、後から届く情報にしない。
//
// 在席・位置は WebSocket、勤怠やお知らせは HTTP のまま。
// ここで先に読むのは「村の形」だけで、変わり続けるものは含めない。
import { pool } from "@/lib/db";
import VillageClient from "./village-client";
import type { Room } from "@/village/render";

// 毎回DBから読む。部屋の追加や定員の変更が、次に開いたときに反映されるように
export const dynamic = "force-dynamic";

async function loadRooms(): Promise<Room[]> {
  const { rows } = await pool.query(
    `SELECT id, name, kind, capacity, deco FROM rooms WHERE deleted_at IS NULL ORDER BY id ASC`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    kind: r.kind === "hall" ? "hall" : "room",
    capacity: Number(r.capacity),
    deco: r.deco,
  }));
}

export default async function Page() {
  const rooms = await loadRooms();
  return <VillageClient initialRooms={rooms} />;
}
