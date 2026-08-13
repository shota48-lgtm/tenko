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
// 生きている人の在席は WebSocket、勤怠やお知らせは HTTP のまま。
//
// **デモ用の利用者の在席だけは、ここでも読んで最初のHTMLに載せる（Phase 5 段階7）。**
//   無料枠の ws-server は15分の無通信で停止する。止まっている間、
//   WS からしか在席が来ない形だと、村は建物と草地だけになる。
//   採用担当が初めて開く瞬間が、まさにその状態になりうる。
//   デモ用の在席は変わり続ける情報ではない（DBの行そのもの）ので、村の形と同じ扱いにしてよい。
import { pool } from "@/lib/db";
import VillageClient from "./village-client";
import type { Room } from "@/village/render";
import { currentActor } from "@/lib/actor";
import { PUBLIC_VIEW, demoPresence } from "@/lib/public-view";
import { redirect } from "next/navigation";

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
  // 誰として村に入るかは、ここ（サーバー側）で決める。
  // 画面側に決めさせない（Phase 5 段階3。以前は URL の ?me= で誰にでもなれた）。
  // 未ログインなら null を渡す。村は見えるが、自分のアバターは出ない
  const actor = await currentActor();

  // 見るだけモードを無効にしているときは、村そのものを見せない。
  // 「建物だけ見える」のような中途半端な状態は作らない（public-view.ts に理由を書いた）
  if (!actor && !PUBLIC_VIEW) redirect("/login");

  const rooms = await loadRooms();

  // デモ用の在席と、それで埋まる部屋の人数。
  // WS が繋がれば、WS から来た一覧で丸ごと置き換わる（同じ値が入るので見た目は変わらない）
  const demo = await demoPresence();
  const initialPeople = demo.map((d) => ({ ...d, connections: 0, demo: true }));
  const initialCounts: Record<number, { used: number; capacity: number }> = {};
  for (const r of rooms) {
    initialCounts[r.id] = {
      used: demo.filter((d) => Number(d.roomId) === r.id).length,
      // 部屋の定員は必ず入っている（rooms.capacity は NOT NULL）。
      // 型の上では省略できることになっているため、既定を置く
      capacity: r.capacity ?? 0,
    };
  }

  const me = actor
    ? {
        id: actor.id,
        name: actor.displayName,
        role: actor.role,
        // 色は利用者IDから決める。画面側で選ばせない（他人と同じ色を名乗れないように）
        colorIndex: ((actor.id - 1) % 4) + 1,
      }
    : null;

  return (
    <VillageClient
      initialRooms={rooms}
      initialPeople={initialPeople}
      initialCounts={initialCounts}
      me={me}
    />
  );
}
