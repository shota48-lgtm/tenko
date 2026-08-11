// 村の描画。地図はデータ（src/village/map.json）から読み、コードにベタ書きしない。
//
// 描画は Canvas を選んだ。理由は PHASE2_LOG.md に記載:
//   40x26 タイル + 装飾231個 + 人物 を DOM 要素で持つと 1000 要素を超え、
//   状態が変わるたびの再描画が重くなる。Canvas なら1枚に描き切れる。
import mapData from "./map.json";
import { layoutBubbles, type BubbleInput, type BubbleLayout } from "./bubbles";
import type { SpriteSheet } from "@/sprites";

export type Presence = {
  id: number;
  name: string;
  colorIndex: number;
  state: "idle" | "away" | "talking" | "resting";
  roomId: number | null;
  // 話しかけてよいかの軸。在席状態とは独立して持つ（機能3）
  talk?: TalkStatus;
};
export type TalkStatus = "ok" | "later" | "focus";
// 利用者ID -> 今日やること（機能1）
export type NoteMap = Record<number, string>;
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
    // 話しかけてよいかは、人物の足元の色付きの点で示す（機能3）。
    // 状態の組み合わせごとにドット絵を用意すると 4状態×3段階=12枚になるため、印を重ねる方式にした
    drawTalkMark(ctx, s, spot.p.talk, Math.round(spot.x), Math.round(spot.y));
  }
}

// 話しかけてよいかの印。ドット絵は増やさず、既存パレットの色で2x2の点を打つ
const TALK_SLOT: Record<TalkStatus, number> = {
  ok: 15,     // 服C（緑系）
  later: 10,  // 明かり（黄系）
  focus: 13,  // 服A（赤系）
};
export function drawTalkMark(
  ctx: CanvasRenderingContext2D,
  s: SpriteSheet,
  talk: TalkStatus | undefined,
  x: number,
  y: number,
) {
  if (!talk) return;
  const color = s.palette[TALK_SLOT[talk]];
  const edge = s.palette[5];
  if (!color) return;
  ctx.fillStyle = edge;
  ctx.fillRect(x + 10, y + 11, 4, 4);
  ctx.fillStyle = color;
  ctx.fillRect(x + 11, y + 12, 2, 2);
}

// 吹き出しを出さない人の頭上に、小さな「メモあり」の印だけを描く。
// 吹き出し本体は HTML 側（案B）で描く。Canvas に文字を描く案Aは、
// 文字幅を測らずに枠を引いていたため、はみ出しが起きて不採用になった（PO判定）。
export function drawNoteMarks(
  ctx: CanvasRenderingContext2D,
  s: SpriteSheet,
  layout: BubbleLayout,
) {
  const edge = s.palette[5];
  const fill = s.palette[8];
  for (const m of layout.markOnly) {
    ctx.fillStyle = edge;
    ctx.fillRect(m.x + 6, m.y - 4, 5, 4);
    ctx.fillStyle = fill;
    ctx.fillRect(m.x + 7, m.y - 3, 3, 2);
  }
}

// 吹き出しの配置を作る。村にいる人のうち、今日やることを書いた人だけが対象
export function bubbleLayoutFor(rooms: Room[], people: Presence[], notes: NoteMap) {
  const spots = personSpots(rooms, people);
  const inputs: BubbleInput[] = [];
  for (const spot of spots) {
    const body = notes[spot.p.id];
    if (!body) continue;
    inputs.push({ userId: spot.p.id, x: Math.round(spot.x), y: Math.round(spot.y), text: body });
  }
  return layoutBubbles(inputs, VILLAGE_W, VILLAGE_H);
}

export function hitBuilding(rooms: Room[], x: number, y: number): Room | null {
  for (const r of buildingRects(rooms)) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.room;
  }
  return null;
}
