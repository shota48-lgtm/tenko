// 村の描画。地図はデータ（src/village/map.json）から読み、コードにベタ書きしない。
//
// 描画は Canvas を選んだ。理由は PHASE2_LOG.md に記載:
//   40x26 タイル + 装飾231個 + 人物 を DOM 要素で持つと 1000 要素を超え、
//   状態が変わるたびの再描画が重くなる。Canvas なら1枚に描き切れる。
import mapData from "./map.json";
import type { SpriteSheet } from "@/sprites";

export type Presence = {
  id: number;
  name: string;
  colorIndex: number;
  state: "idle" | "away" | "talking" | "resting";
  roomId: number | null;
};
// kind は rooms テーブルの列。どの建物で描くかは並び順ではなくこの値だけで決まる
export type Room = { id: number; name: string; kind: "room" | "hall" };
export type BuildingRect = { room: Room; x: number; y: number; w: number; h: number };

export const villageMap = mapData;
export const TILE = mapData.tile;
export const VILLAGE_W = mapData.width * mapData.tile;
export const VILLAGE_H = mapData.height * mapData.tile;

function paint(ctx: CanvasRenderingContext2D, s: SpriteSheet, name: string, ox: number, oy: number, flip = false) {
  const g = s.sprites[name];
  if (!g) return;
  for (let y = 0; y < g.length; y++) {
    for (let x = 0; x < g[y].length; x++) {
      const c = s.palette[g[y][x]];
      if (!c || c === "transparent") continue;
      const xx = flip ? g[y].length - 1 - x : x;
      ctx.fillStyle = c;
      ctx.fillRect(ox + xx, oy + y, 1, 1);
    }
  }
}

// 建物の位置。部屋の行数に応じて枠を使う（部屋が増えれば建物が増える）
export function buildingRects(rooms: Room[]): BuildingRect[] {
  return rooms.slice(0, villageMap.buildingSlots.length).map((room, i) => {
    const slot = villageMap.buildingSlots[i];
    return { room, x: slot.x * TILE, y: slot.y * TILE, w: 32, h: 32 };
  });
}

// 人物の配置。位置は状態が決める。自由移動は実装しない
export function personSpots(rooms: Room[], people: Presence[]) {
  const rects = buildingRects(rooms);
  const out: { p: Presence; x: number; y: number }[] = [];
  const byRoom = new Map<number, Presence[]>();
  const plaza: Presence[] = [];
  for (const p of people) {
    if (p.roomId != null && rects.some((r) => r.room.id === p.roomId)) {
      const arr = byRoom.get(p.roomId) ?? [];
      arr.push(p);
      byRoom.set(p.roomId, arr);
    } else {
      plaza.push(p);
    }
  }
  // 部屋にいる人は、その建物の直下に横へずらして並べる
  for (const [roomId, arr] of byRoom) {
    const r = rects.find((x) => x.room.id === roomId)!;
    arr.forEach((p, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      out.push({ p, x: r.x - 4 + col * 13, y: r.y + 30 + row * 14 });
    });
  }
  // どの部屋にも入っていない人は広場（噴水の周り）に並べる
  plaza.forEach((p, i) => {
    const spot = villageMap.plazaSpots[i % villageMap.plazaSpots.length];
    const wrap = Math.floor(i / villageMap.plazaSpots.length);
    out.push({ p, x: spot.x + wrap * 6, y: spot.y + wrap * 6 });
  });
  return out;
}

export function drawVillage(
  ctx: CanvasRenderingContext2D,
  s: SpriteSheet,
  rooms: Room[],
  people: Presence[],
) {
  ctx.imageSmoothingEnabled = false;
  const m = villageMap;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      paint(ctx, s, (x * 7 + y * 13) % 5 === 0 ? "grass_alt" : "grass", x * TILE, y * TILE);
    }
  }
  for (const ry of m.roads.h) {
    for (let x = 0; x < m.width; x++) {
      paint(ctx, s, "path", x * TILE, ry * TILE);
      paint(ctx, s, "path_edge_n", x * TILE, (ry - 1) * TILE);
      paint(ctx, s, "path_edge_s", x * TILE, (ry + 1) * TILE);
    }
  }
  for (const rx of m.roads.v) {
    for (let y = 0; y < m.height; y++) {
      paint(ctx, s, "path", rx * TILE, y * TILE);
      paint(ctx, s, "path_edge_e", (rx - 1) * TILE, y * TILE);
      paint(ctx, s, "path_edge_e", (rx + 1) * TILE, y * TILE, true);
    }
  }
  for (const d of m.deco) paint(ctx, s, d.sprite, d.x * TILE, d.y * TILE);

  // 建物。その部屋で会話中の人がいれば窓を明るくする
  const talkingRooms = new Set(people.filter((p) => p.state === "talking" && p.roomId != null).map((p) => p.roomId));
  buildingRects(rooms).forEach((r) => {
    const isHall = r.room.kind === "hall";
    const lit = talkingRooms.has(r.room.id);
    paint(ctx, s, (isHall ? "hall" : "house") + (lit ? "_lit" : ""), r.x, r.y);
  });

  paint(ctx, s, "fountain", m.fountain.x * TILE, m.fountain.y * TILE);

  // 退勤した人は描画しない（presence に載っていない人は描かれない）
  for (const spot of personSpots(rooms, people)) {
    const n = ((spot.p.colorIndex - 1) % 4) + 1;
    paint(ctx, s, "person_" + spot.p.state + "_" + n, Math.round(spot.x), Math.round(spot.y));
  }
}

export function hitBuilding(rooms: Room[], x: number, y: number): Room | null {
  for (const r of buildingRects(rooms)) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.room;
  }
  return null;
}
