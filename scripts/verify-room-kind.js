// 作業3-1,2: 建物の種別が rooms.kind だけで決まり、並び順に依存しないことの確認。
// 本番の描画コード（コンパイルした render.ts）で村を描き、建物1棟ぶんの画素を切り出して突き合わせる。
const fs = require("fs");
const R = require(process.argv[2] + "/compiled/render.js");
const sheet = JSON.parse(fs.readFileSync("src/sprites/variant-a.json", "utf8"));

function renderAll(rooms) {
  const W = R.VILLAGE_W, H = R.VILLAGE_H;
  const buf = new Uint8Array(W * H * 3);
  let cur = null;
  const ctx = {
    imageSmoothingEnabled: true,
    set fillStyle(v) { cur = v === "transparent" ? null : [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)]; },
    get fillStyle() { return ""; },
    fillRect(x, y, w, h) {
      if (!cur) return;
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
        const px = x + dx, py = y + dy;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const i = (py * W + px) * 3;
        buf[i] = cur[0]; buf[i + 1] = cur[1]; buf[i + 2] = cur[2];
      }
    },
    clearRect() {},
  };
  R.drawVillage(ctx, sheet, rooms, []);
  return { buf, W };
}
function crop(r, rect) {
  const out = [];
  for (let y = rect.y; y < rect.y + 32; y++) for (let x = rect.x; x < rect.x + 32; x++) {
    const i = (y * r.W + x) * 3;
    out.push(r.buf[i], r.buf[i + 1], r.buf[i + 2]);
  }
  return out.join(",");
}
// 建物の見た目を、その部屋の kind ごとに集める
function shapes(rooms) {
  const r = renderAll(rooms);
  const rects = R.buildingRects(rooms);
  return rects.map((rc, i) => ({ id: rooms[i].id, kind: rooms[i].kind, slot: rc.x + "," + rc.y, look: crop(r, rc) }));
}

const rooms = [
  { id: 1, name: "オフィス", kind: "room" },
  { id: 2, name: "会議室", kind: "hall" },
  { id: 3, name: "開発", kind: "room" },
  { id: 4, name: "全体", kind: "hall" },
  { id: 5, name: "雑談", kind: "room" },
];

// 枠ごとに背景（草・装飾）が違うため、切り出した画素をそのまま比べると背景の差が混ざる。
// 同じ枠に対して「全部 room で描いた場合」「全部 hall で描いた場合」を参照として作り、
// 実際の描画がどちらと一致するかで種別を判定する。
const refRoom = shapes(rooms.map((r) => ({ ...r, kind: "room" })));
const refHall = shapes(rooms.map((r) => ({ ...r, kind: "hall" })));
const judge = (list) => list.map((s, i) =>
  s.look === refRoom[i].look ? "house" : (s.look === refHall[i].look ? "hall" : "不明"));

const A = shapes(rooms);
console.log("== 1. kind の反映 ==");
console.log("  " + A.map((s) => "部屋" + s.id + "=" + s.kind).join(" / "));
const drawnA = judge(A);
console.log("  実際に描かれた建物: " + A.map((s, i) => "部屋" + s.id + "->" + drawnA[i]).join(" / "));
console.log("  kind と描画が一致: " + A.every((s, i) => (s.kind === "hall") === (drawnA[i] === "hall")));
console.log("  house と hall は別の見た目: " + (refRoom[0].look !== refHall[0].look));

console.log("== 2. 並び順への非依存 ==");
const reordered = [rooms[4], rooms[3], rooms[2], rooms[1], rooms[0]];
const B = shapes(reordered);
console.log("  " + B.map((s) => "部屋" + s.id + "=" + s.kind).join(" / "));
const byId = {};
for (const s of A) byId[s.id] = s.look;
// 枠が変わると座標が変わるので、見た目そのものではなく「種別ごとの見た目」で比べる
const drawnB = judge(B);
console.log("  実際に描かれた建物: " + B.map((s, i) => "部屋" + s.id + "->" + drawnB[i]).join(" / "));
console.log("  kind と描画が一致: " + B.every((s, i) => (s.kind === "hall") === (drawnB[i] === "hall")));
console.log("  並べ替えで hall になった部屋: " + B.filter((s) => s.kind === "hall").map((s) => s.id).join(",") + "（並べ替え前: " + A.filter((s) => s.kind === "hall").map((s) => s.id).join(",") + "）");

console.log("== 3. 旧規則（5件に1件）が残っていないか ==");
const five = [1, 2, 3, 4, 5].map((i) => ({ id: i, name: "部屋" + i, kind: "room" }));
const C = shapes(five);
const drawnC = C.map((s, i) => s.look === refRoom[i].look ? "house" : (s.look === refHall[i].look ? "hall" : "不明"));
console.log("  全件 room のときの描画: " + drawnC.join(" / ") + "（旧規則なら5棟目が hall になる）");