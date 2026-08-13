// 村の描画。地図はデータ（src/village/map.json）から読み、コードにベタ書きしない。
//
// 描画は Canvas を選んだ。理由は PHASE2_LOG.md に記載:
//   40x26 タイル + 装飾231個 + 人物 を DOM 要素で持つと 1000 要素を超え、
//   状態が変わるたびの再描画が重くなる。Canvas なら1枚に描き切れる。
import mapData from "./map.json";
import { layoutBubbles, BUBBLE, type BubbleInput, type BubbleLayout } from "./bubbles";
import type { SpriteSheet } from "@/sprites";

export type Presence = {
  id: number;
  // 名前は presence には無い。DBの表示名を使う（自己申告の名前を他人の画面に出さないため）
  colorIndex: number;
  state: "idle" | "away" | "talking" | "resting";
  roomId: number | null;
  // 話しかけてよいかの軸。在席状態とは独立して持つ（機能3）
  talk?: TalkStatus;
  // 村の中の位置。Phase 4.8 で自由移動を入れたため、位置はその人が持つ。
  // 決めるのは ws-server（画面側の値は信用しない）。まだ届いていない間だけ undefined
  x?: number;
  y?: number;
  // デモ用の利用者（接続を持たず、常に村にいる人）。Phase 5 段階5。
  // 呼びかけ・チャットの案内を変えるために使う（返事が来ないのを不具合に見せない）
  demo?: boolean;
};
export type TalkStatus = "ok" | "later" | "focus";
// 利用者ID -> 今日やること（機能1）
export type NoteMap = Record<number, string>;
// kind は rooms テーブルの列。どの建物で描くかは並び順ではなくこの値だけで決まる
// capacity は定員（Phase 4.8）。満員の判定はサーバー側で行い、ここでは見せるだけ
// deco は屋根の印を決める列（Phase 4.10）。名前からは推測しない
export type Room = { id: number; name: string; kind: "room" | "hall"; capacity?: number; deco?: string };
// 部屋ごとの人数。ws-server が配る
export type RoomCounts = Record<number, { used: number; capacity: number }>;
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

// 部屋ごとの印。7棟が同じ絵なので、色と形で性格を分ける。
// 新しい32x32のスプライトは作らない。建物の絵はそのままに、屋根の下へ小さな看板を描く。
// 色はパレット16色から採る（色数を増やさない）
export type RoomDeco = "dev" | "sales" | "meeting" | "rest" | "support" | "office" | "hall" | "other";
type Mark = { color: number; shape: "square" | "triangle" | "cross" | "circle" | "bar" | "diamond" | "dot" };

// 種別ごとの印。色はパレット16色から採る（色数を増やさない）。
// 形も変えているのは、色だけに頼らないため（色の見分けがつかない人にも区別できる）
const ROOM_MARKS: Record<RoomDeco, Mark> = {
  dev: { color: 14, shape: "square" },      // 青・四角
  sales: { color: 13, shape: "triangle" },  // 赤・三角
  meeting: { color: 12, shape: "bar" },     // 紫・横棒
  rest: { color: 15, shape: "circle" },     // 緑・丸
  support: { color: 6, shape: "cross" },    // 藁色・十字
  office: { color: 9, shape: "diamond" },   // 木・ひし形
  hall: { color: 10, shape: "dot" },        // 明るい藁・点
  other: { color: 5, shape: "dot" },        // 濃色・点
};

// 印は rooms.deco の値だけで決まる（Phase 4.10）。
// 以前は部屋名に含まれる語から決めていたため、名前を変えると印が変わる形になっていた。
// 見た目を決める値は名前とは別に持つ
export function markFor(room: Room): Mark {
  const key = (room.deco ?? "other") as RoomDeco;
  return ROOM_MARKS[key] ?? ROOM_MARKS.other;
}

function drawRoomMark(ctx: CanvasRenderingContext2D, s: SpriteSheet, r: BuildingRect) {
  const m = markFor(r.room);
  const color = s.palette[m.color] ?? "#333";
  const x = r.x + 24;
  const y = r.y + 3;
  ctx.save();
  ctx.fillStyle = "#33302a";
  ctx.fillRect(x - 1, y - 1, 7, 7);   // 枠。地面と同化しないように敷く
  ctx.fillStyle = color;
  if (m.shape === "square") ctx.fillRect(x, y, 5, 5);
  else if (m.shape === "bar") ctx.fillRect(x, y + 1, 5, 3);
  else if (m.shape === "circle") { ctx.fillRect(x + 1, y, 3, 5); ctx.fillRect(x, y + 1, 5, 3); }
  else if (m.shape === "cross") { ctx.fillRect(x + 2, y, 1, 5); ctx.fillRect(x, y + 2, 5, 1); }
  else if (m.shape === "triangle") {
    ctx.fillRect(x + 2, y, 1, 1); ctx.fillRect(x + 1, y + 1, 3, 1);
    ctx.fillRect(x, y + 2, 5, 1); ctx.fillRect(x, y + 3, 5, 1);
  } else if (m.shape === "diamond") {
    ctx.fillRect(x + 2, y, 1, 1); ctx.fillRect(x + 1, y + 1, 3, 1);
    ctx.fillRect(x, y + 2, 5, 1); ctx.fillRect(x + 1, y + 3, 3, 1);
    ctx.fillRect(x + 2, y + 4, 1, 1);
  } else if (m.shape === "dot") {
    ctx.fillRect(x + 1, y + 1, 3, 3);
  }
  ctx.restore();
}

// 何人入っているかの帯。建物の下に敷く。
// 0人（空の枠だけ）・途中（緑が伸びる）・満員（赤で埋まる）が離れて見ても区別できる
function drawSeatBar(ctx: CanvasRenderingContext2D, r: BuildingRect, used: number, cap: number) {
  if (cap <= 0) return;
  const w = r.w - 2;
  const x = r.x + 1;
  const y = r.y + r.h + 1;
  ctx.save();
  ctx.fillStyle = "#33302a";
  ctx.fillRect(x - 1, y - 1, w + 2, 5);
  ctx.fillStyle = "#e8c9a0";
  ctx.fillRect(x, y, w, 3);
  if (used > 0) {
    ctx.fillStyle = used >= cap ? "#b2503a" : "#5f7f45";
    ctx.fillRect(x, y, Math.max(2, Math.round((w * Math.min(used, cap)) / cap)), 3);
  }
  ctx.restore();
}

// 未読の投稿がある建物の印。会話中の窓の光とは別に、屋根の上へ黄色い旗を立てる。
// 光り方を変えるだけだと「誰かいる」との区別が付かない
function drawUnreadFlag(ctx: CanvasRenderingContext2D, r: BuildingRect) {
  const x = r.x + 3;
  const y = r.y - 8;
  ctx.save();
  ctx.fillStyle = "#33302a";
  ctx.fillRect(x, y, 1, 9);
  ctx.fillRect(x + 1, y, 7, 6);
  ctx.fillStyle = "#f2d489";
  ctx.fillRect(x + 1, y + 1, 6, 4);
  ctx.restore();
}

// 建物の位置。部屋の行数に応じて枠を使う（部屋が増えれば建物が増える）
export function buildingRects(rooms: Room[]): BuildingRect[] {
  return rooms.slice(0, villageMap.buildingSlots.length).map((room, i) => {
    const slot = villageMap.buildingSlots[i];
    return { room, x: slot.x * TILE, y: slot.y * TILE, w: 32, h: 32 };
  });
}

// 村の端で切れないように、人物を村の中に収める。
// 自由移動を入れたため、利用者は端まで行ける（Phase 4.8 作業7）
// 人物の下に出るもの（足元のリングと名前のラベル）の高さ。
// ws-server/geometry.js の BOTTOM_MARGIN と揃えること
export const BOTTOM_MARGIN = 18;

export function clampToVillage(x: number, y: number) {
  return {
    x: Math.round(Math.min(Math.max(x, 0), VILLAGE_W - PERSON_SIZE)),
    y: Math.round(Math.min(Math.max(y, 0), VILLAGE_H - PERSON_SIZE - BOTTOM_MARGIN)),
  };
}

// 位置がまだ届いていない人の初期値。ws-server/geometry.js の defaultSpot と揃える
function fallbackSpot(index: number) {
  const gapX = PERSON_SIZE + 12;
  const gapY = PERSON_SIZE + 18;
  const col = index % 8;
  const row = Math.floor(index / 8) % 3;
  const wrap = Math.floor(index / 24);
  return clampToVillage(
    villageMap.plaza.x * TILE + col * gapX + wrap * 6,
    villageMap.plaza.y * TILE + row * gapY + wrap * 6,
  );
}

// 人物の配置。Phase 4.8 で「位置が状態を決める」形に変わったため、
// 位置はその人が持っている値をそのまま使う。ここで並べ直さない。
// 座標を決めるのは ws-server。画面側は受け取った値を村の中に収めるだけ
export function personSpots(rooms: Room[], people: Presence[]) {
  void rooms;
  return people.map((p, i) => {
    const at = p.x != null && p.y != null ? clampToVillage(p.x, p.y) : fallbackSpot(i);
    return { p, x: at.x, y: at.y };
  });
}

// 地面・道・装飾だけを描く。中身は変わらないので、画面側は一度だけ描いて使い回す。
// 1ドットずつ塗るため、村全体で約27万回の描画になる。
// 在席が変わるたびにこれを描き直すと画面が固まる（実機で確認）。
export function drawGround(ctx: CanvasRenderingContext2D, s: SpriteSheet, quietDeco = true) {
  ctx.imageSmoothingEnabled = false;
  const m = villageMap;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      paint(ctx, s, (x * 7 + y * 13) % 5 === 0 ? "grass_alt" : "grass", x * TILE, y * TILE);
    }
  }
  // 道は半タイル（8ドット）ずらして描く。
  //
  // 村は 40x26 タイルで偶数のため、村の中心 (320,208) はタイルの境界の上にある。
  // 道をタイル単位で置くと中心が必ず半タイルずれる（実測: 縦の道の中心が 328 で、8ドット右）。
  // タイル数を奇数にしても、境界が中心のこの村では中心が合わない（奇数だとタイルの真ん中が中心になる）。
  // 幅を2タイルにすれば揃うが、道の太さが倍になって見た目が変わる。
  // そこで幅は変えず、描く位置だけを roadShift ドットずらす。
  //
  // 草地は先に全面を塗ってあるので、ずらしても隙間はできない。
  // 縦の道は x だけ、横の道は y だけずらすため、タイルの繰り返し（もう一方の軸）は崩れない。
  const shift = m.roadShift ?? 0;
  for (const ry of m.roads.h) {
    for (let x = 0; x < m.width; x++) {
      paint(ctx, s, "path", x * TILE, ry * TILE + shift);
      paint(ctx, s, "path_edge_n", x * TILE, (ry - 1) * TILE + shift);
      paint(ctx, s, "path_edge_s", x * TILE, (ry + 1) * TILE + shift);
    }
  }
  for (const rx of m.roads.v) {
    for (let y = 0; y < m.height; y++) {
      paint(ctx, s, "path", rx * TILE + shift, y * TILE);
      paint(ctx, s, "path_edge_e", (rx - 1) * TILE + shift, y * TILE);
      paint(ctx, s, "path_edge_e", (rx + 1) * TILE + shift, y * TILE, true);
    }
  }
  // 装飾231個は村らしさを作るが、人物が埋もれる（作業4-3）。
  // 数を減らすと村が寂しくなるため、彩度ではなく「地に馴染ませる」方向にした。
  // 描いたうえから地の色を薄くかけると、人物（この後で描く）だけが前に出る
  for (const d of m.deco) paint(ctx, s, d.sprite, d.x * TILE, d.y * TILE);
  if (quietDeco) {
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = s.palette[1];   // 草の色。装飾だけでなく地面全体にかける
    ctx.fillRect(0, 0, VILLAGE_W, VILLAGE_H);
    ctx.restore();
  }
}

// 建物の中の人をどう見せるか。2案を実機で見比べて決める（Phase 4.8 作業2）
//   "show": そのまま重ねて描く。誰がいるか一目で分かる
//   "hide": 建物の中の人は描かず、人数だけ出す。村がすっきりする
export type OccupantsMode = "show" | "hide";

// 変わるものだけを描く（建物の窓・噴水・人物）。在席が変わるたびに呼ぶのはこちら
export function drawVillage(
  ctx: CanvasRenderingContext2D,
  s: SpriteSheet,
  rooms: Room[],
  people: Presence[],
  withGround = true,
  counts: RoomCounts = {},
  occupants: OccupantsMode = "show",
  highlight: number | null = null,
  unread: Record<number, number> = {},
  // 自分だけは、建物の中にいても必ず描く。
  // 描かないと掴めず、建物から出られなくなる（実機で確認）
  meId: number | null = null,
) {
  ctx.imageSmoothingEnabled = false;
  const m = villageMap;
  if (withGround) drawGround(ctx, s);

  // 建物。誰か入っていれば窓を明るくし、下に人数の帯を出す
  buildingRects(rooms).forEach((r) => {
    const isHall = r.room.kind === "hall";
    const c = counts[r.room.id];
    const used = c?.used ?? 0;
    const cap = c?.capacity ?? r.room.capacity ?? 0;
    const full = cap > 0 && used >= cap;
    paint(ctx, s, (isHall ? "hall" : "house") + (used > 0 ? "_lit" : ""), r.x, r.y);
    // 部屋の性格を色で分ける。7棟が同じ見た目では、どれがどの部屋か分からない
    drawRoomMark(ctx, s, r);
    // 何人いるかを常時出す。0人・途中・満員が離れて見ても区別できるようにする
    drawSeatBar(ctx, r, used, cap);
    if (full) {
      // 満員は枠でも示す。人数の帯だけでは、遠目に埋まり具合が読み取りにくい
      ctx.save();
      ctx.strokeStyle = "#b2503a";
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
      ctx.restore();
    }
    if (unread[r.room.id] > 0) drawUnreadFlag(ctx, r);
    // ドラッグ中に、いま離したら入る建物を光らせる
    if (highlight === r.room.id) {
      ctx.save();
      ctx.strokeStyle = full ? "#b2503a" : "#f2d489";
      ctx.lineWidth = 2;
      ctx.setLineDash(full ? [3, 3] : []);
      const m = ENTER_MARGIN;
      ctx.strokeRect(r.x - m, r.y - m, r.w + m * 2, r.h + m * 2);
      ctx.restore();
    }
  });

  paint(ctx, s, "fountain", m.fountain.x * TILE, m.fountain.y * TILE);

  // 退勤した人は描画しない（presence に載っていない人は描かれない）
  for (const spot of personSpots(rooms, people)) {
    if (occupants === "hide" && spot.p.roomId != null && Number(spot.p.id) !== meId) continue;
    const n = ((spot.p.colorIndex - 1) % 4) + 1;
    const x = Math.round(spot.x);
    const y = Math.round(spot.y);
    // 状態は足元のリングで示す。人物の下に敷くので先に描く
    drawStateRing(ctx, spot.p.state, x, y);
    paint(ctx, s, "person_" + spot.p.state + "_" + n, x, y, false, PERSON_SCALE);
    // 自分は枠で囲む。50人いると「あなた」の札だけでは探すのに時間がかかる（作業2-3）
    if (Number(spot.p.id) === meId) {
      ctx.save();
      ctx.strokeStyle = "#f2d489";
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 3, y - 3, PERSON_SIZE + 6, PERSON_SIZE + 6);
      ctx.strokeStyle = "#33302a";
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 4.5, y - 4.5, PERSON_SIZE + 9, PERSON_SIZE + 9);
      ctx.restore();
    }
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
export function bubbleLayoutFor(
  rooms: Room[],
  people: Presence[],
  notes: NoteMap,
  maxVisible?: number,
  only?: number[],
  // 全員分を出すときは1行に絞る。2行のままだと高さが倍になり、他人の名前を覆う
  maxLines?: number,
) {
  const spots = personSpots(rooms, people);
  const inputs: BubbleInput[] = [];
  for (const spot of spots) {
    const body = notes[spot.p.id];
    if (!body) continue;
    // only が指定されていれば、その人の吹き出しだけを出す（マウスを乗せた人だけ出す方式）
    if (only && !only.includes(Number(spot.p.id))) continue;
    inputs.push({ userId: spot.p.id, x: Math.round(spot.x), y: Math.round(spot.y), text: body });
  }
  const opt: Partial<typeof BUBBLE> = {};
  if (maxVisible != null) opt.maxVisible = maxVisible;
  if (maxLines != null) opt.maxLines = maxLines;
  // 名前のラベルの位置。吹き出しがここに重ならないようにする。
  // 画面側は名前を人物の下（y + PERSON_SIZE + 5）に置いている
  const blockers = spots.map((s) => ({
    x: Math.round(s.x) - 8,
    y: Math.round(s.y) + PERSON_SIZE + 3,
    w: PERSON_SIZE + 16,
    h: 10,
  }));
  return { ...layoutBubbles(inputs, VILLAGE_W, VILLAGE_H, opt, blockers), spots };
}

// 噴水（お知らせ）の当たり判定。建物と同じく、押しやすいよう少し広く取る
export const fountainRect = {
  x: villageMap.fountain.x * TILE,
  y: villageMap.fountain.y * TILE,
  w: 32,
  h: 32,
};
export function hitFountain(x: number, y: number): boolean {
  const m = 6;
  const f = fountainRect;
  return x >= f.x - m && x < f.x + f.w + m && y >= f.y - m && y < f.y + f.h + m;
}

export function hitBuilding(rooms: Room[], x: number, y: number): Room | null {
  for (const r of buildingRects(rooms)) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.room;
  }
  return null;
}

// 建物の判定に足す余白。ws-server/geometry.js の ENTER_MARGIN と揃えること
export const ENTER_MARGIN = 12;

// その位置に人物を置いたら、どの建物に入るか。
// 判定するのはサーバーだが、ドラッグ中に「どこへ入るか」を見せるために画面側でも同じ計算をする。
// 片方だけ変えると、光った建物に入れないという食い違いが起きる
export function buildingForAvatar(rooms: Room[], x: number, y: number): BuildingRect | null {
  const cx = x + PERSON_SIZE / 2;
  const cy = y + PERSON_SIZE / 2;
  let best: BuildingRect | null = null;
  let bestD = Infinity;
  for (const r of buildingRects(rooms)) {
    const m = ENTER_MARGIN;
    if (cx >= r.x - m && cx < r.x + r.w + m && cy >= r.y - m && cy < r.y + r.h + m) {
      const d = (cx - (r.x + r.w / 2)) ** 2 + (cy - (r.y + r.h / 2)) ** 2;
      if (d < bestD) { bestD = d; best = r; }
    }
  }
  return best;
}
