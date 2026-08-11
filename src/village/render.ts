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

function paint(ctx: CanvasRenderingContext2D, s: SpriteSheet, name: string, ox: number, oy: number, flip = false, k = 1) {
  const g = s.sprites[name];
  if (!g) return;
  for (let y = 0; y < g.length; y++) {
    for (let x = 0; x < g[y].length; x++) {
      const c = s.palette[g[y][x]];
      if (!c || c === "transparent") continue;
      const xx = flip ? g[y].length - 1 - x : x;
      ctx.fillStyle = c;
      // k は整数倍のみ。半端な倍率だとドットの大きさが揃わず、絵が濁る
      ctx.fillRect(ox + xx * k, oy + y * k, k, k);
    }
  }
}

// 人物の大きさ。16ドットのままだと村全体の中で小さく、
// リング・名前・話しかけ可否を載せる余地もない（oVice もアバターを1.6倍に拡大している）。
// 整数倍でしか拡大できないため 2 倍にした。判断の経緯は PHASE47_LOG.md に記載
export const PERSON_SCALE = 2;
export const PERSON_SIZE = 16 * PERSON_SCALE;

// 状態を色で示すリング。色だけに頼らず、形（線の数・太さ）でも区別する
const RING: Record<Presence["state"], { color: string; style: "solid" | "double" | "dashed" | "dotted" }> = {
  idle: { color: "#2f7d4f", style: "solid" },     // 在席: 緑の実線
  talking: { color: "#2563a8", style: "double" }, // 会話中: 青の二重
  resting: { color: "#c08a2e", style: "dashed" }, // 休憩中: 橙の破線
  away: { color: "#8a8578", style: "dotted" },    // 離席: 灰の点線
};

export function drawStateRing(
  ctx: CanvasRenderingContext2D,
  state: Presence["state"],
  x: number,
  y: number,
) {
  const r = RING[state];
  const cx = x + PERSON_SIZE / 2;
  // 足の真下に敷く。人物の絵は 32 ドットの下端まで使っているので、その少し下に置く
  const cy = y + PERSON_SIZE - 1;
  const rx = PERSON_SIZE * 0.42;
  const ry = PERSON_SIZE * 0.17;

  ctx.save();
  ctx.strokeStyle = r.color;
  ctx.lineWidth = 2;
  if (r.style === "dashed") ctx.setLineDash([5, 3]);
  if (r.style === "dotted") ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  if (r.style === "double") {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx - 3.5, ry - 1.5, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
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
  // 部屋にいる人は、その建物の直下に横へずらして並べる。
  // 人物を2倍にしたため、間隔も広げないと重なる（Phase 4.7）
  // 人物を2倍にしたうえ、足元のリングと名前のラベルが載るため、間隔を広く取る
  const gapX = PERSON_SIZE + 12;
  const gapY = PERSON_SIZE + 18;
  for (const [roomId, arr] of byRoom) {
    const r = rects.find((x) => x.room.id === roomId)!;
    arr.forEach((p, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      out.push({ p, x: r.x - gapX + col * gapX, y: r.y + 34 + row * gapY });
    });
  }
  // どの部屋にも入っていない人は広場（噴水の周り）に並べる
  plaza.forEach((p, i) => {
    const wrap = Math.floor(i / villageMap.plazaSpots.length);
    // 地図の広場の位置は16ドットの人物を前提に並べてある。
    // 2倍にした分だけ横に広げ、重ならないようにする
    const col = i % 8;
    const row = Math.floor((i % villageMap.plazaSpots.length) / 8);
    out.push({
      p,
      x: villageMap.plaza.x * TILE + col * gapX + wrap * 6,
      y: villageMap.plaza.y * TILE + row * gapY + wrap * 6,
    });
  });
  return out;
}

// 地面・道・装飾だけを描く。中身は変わらないので、画面側は一度だけ描いて使い回す。
// 1ドットずつ塗るため、村全体で約27万回の描画になる。
// 在席が変わるたびにこれを描き直すと画面が固まる（実機で確認）。
export function drawGround(ctx: CanvasRenderingContext2D, s: SpriteSheet) {
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
}

// 変わるものだけを描く（建物の窓・噴水・人物）。在席が変わるたびに呼ぶのはこちら
export function drawVillage(
  ctx: CanvasRenderingContext2D,
  s: SpriteSheet,
  rooms: Room[],
  people: Presence[],
  withGround = true,
) {
  ctx.imageSmoothingEnabled = false;
  const m = villageMap;
  if (withGround) drawGround(ctx, s);

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
    const x = Math.round(spot.x);
    const y = Math.round(spot.y);
    // 状態は足元のリングで示す。人物の下に敷くので先に描く
    drawStateRing(ctx, spot.p.state, x, y);
    paint(ctx, s, "person_" + spot.p.state + "_" + n, x, y, false, PERSON_SCALE);
  }
}

// 人物の当たり判定。クリックした位置にいる人を返す（自分ならメニュー、他人なら情報を出す）
export function hitPerson(
  rooms: Room[],
  people: Presence[],
  x: number,
  y: number,
): Presence | null {
  // 後に描かれた人ほど手前にいるので、後ろから探す
  const spots = personSpots(rooms, people);
  for (let i = spots.length - 1; i >= 0; i--) {
    const s = spots[i];
    if (x >= s.x && x < s.x + PERSON_SIZE && y >= s.y && y < s.y + PERSON_SIZE) return s.p;
  }
  return null;
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

// 吹き出しの配置を作る。村にいる人のうち、今日やることを書いた人だけが対象。
// 人物の配置（spots）も一緒に返す。画面側が名前とラベルを同じ座標に重ねるため、
// 同じ計算を2回しないで済む
export function bubbleLayoutFor(rooms: Room[], people: Presence[], notes: NoteMap) {
  const spots = personSpots(rooms, people);
  const inputs: BubbleInput[] = [];
  for (const spot of spots) {
    const body = notes[spot.p.id];
    if (!body) continue;
    inputs.push({ userId: spot.p.id, x: Math.round(spot.x), y: Math.round(spot.y), text: body });
  }
  return { ...layoutBubbles(inputs, VILLAGE_W, VILLAGE_H), spots };
}

export function hitBuilding(rooms: Room[], x: number, y: number): Room | null {
  for (const r of buildingRects(rooms)) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.room;
  }
  return null;
}
