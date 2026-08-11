/* 審査役B: 吹き出しの見え方を、本番の配置計算そのままで PNG に描く。
   自作の PNG 書き出しには文字の描画が無いため、文字は「行ごとの帯」で代替する。
   確認できるのは 枠の位置・大きさ・折り返し・重なり・はみ出し。グリフは確認できない。
   実行: node scripts\render-bubbles.js <出力先> */
const fs = require("fs"), zlib = require("zlib");
const OUT = process.argv[2];
const COMPILED = process.argv[3] || OUT;
const R = require(COMPILED + "/compiled/render.js");
const B = require(COMPILED + "/compiled/bubbles.js");
const sheet = JSON.parse(fs.readFileSync("src/sprites/variant-a.json", "utf8"));

function crc32(b) { let c, crc = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = c ^ (crc >>> 8); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(t, b) { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); const ty = Buffer.from(t, "ascii"); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([ty, b]))); return Buffer.concat([l, ty, b, c]); }
function writePng(f, w, h, rgb) { const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); } const i = Buffer.alloc(13); i.writeUInt32BE(w, 0); i.writeUInt32BE(h, 4); i[8] = 8; i[9] = 2; fs.writeFileSync(f, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", i), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])); }

const W = R.VILLAGE_W, H = R.VILLAGE_H;
function makeCtx(scale) {
  const buf = Buffer.alloc(W * scale * H * scale * 3);
  let cur = null;
  const ctx = {
    imageSmoothingEnabled: true, font: "", textBaseline: "",
    set fillStyle(v) { cur = (typeof v === "string" && v.startsWith("#")) ? [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)] : null; },
    get fillStyle() { return ""; },
    fillRect(x, y, w, h) {
      if (!cur) return;
      for (let dy = 0; dy < Math.round(h * scale); dy++) for (let dx = 0; dx < Math.round(w * scale); dx++) {
        const px = Math.round(x * scale) + dx, py = Math.round(y * scale) + dy;
        if (px < 0 || py < 0 || px >= W * scale || py >= H * scale) continue;
        const i = (py * W * scale + px) * 3;
        buf[i] = cur[0]; buf[i + 1] = cur[1]; buf[i + 2] = cur[2];
      }
    },
    // 文字は描けないので、代わりに文字の占める領域を帯で塗る（幅は配置計算と同じ見込み幅）
    fillText(text, x, y) {
      let w = 0;
      for (const ch of text) { const cp = ch.codePointAt(0); w += (cp <= 0x7e || (cp >= 0xff61 && cp <= 0xff9f)) ? 0.5 : 1; }
      this.fillRect(x, y + 1, w * 6, 5);
    },
    clearRect() {},
  };
  return { ctx, buf };
}

const rooms = [];
for (let i = 1; i <= 6; i++) rooms.push({ id: i, name: "部屋" + i, kind: i % 5 === 4 ? "hall" : "room" });

const NOTES_SHORT = [
  "見積もりの作成", "設計レビュー", "請求書の確認", "リリース準備",
  "採用面談 15時", "在庫の棚卸し", "打ち合わせ資料", "月次の締め",
];
const LONG = "第3四半期の売上見込みの資料をまとめて、部長と課長に共有したうえで、来週の全体会議に向けた読み合わせの時間を確保する";

function people(n, opt = {}) {
  const states = ["idle", "talking", "away", "resting"];
  const talks = ["ok", "later", "focus"];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: i + 1, name: "利用者" + (i + 1), colorIndex: (i % 4) + 1,
      state: states[i % 4], roomId: opt.inRooms && i < 4 ? (i % 3) + 1 : null,
      talk: talks[i % 3],
    });
  }
  return out;
}
function notesFor(ppl, texts) {
  const m = {};
  ppl.forEach((p, i) => { m[p.id] = texts[i % texts.length]; });
  return m;
}

const scenes = [
  { name: "bub-8people", ppl: people(8, { inRooms: true }), notes: (p) => notesFor(p, NOTES_SHORT) },
  { name: "bub-20people", ppl: people(20, { inRooms: true }), notes: (p) => notesFor(p, NOTES_SHORT) },
  { name: "bub-long", ppl: people(8, { inRooms: true }), notes: (p) => notesFor(p, [LONG]) },
  { name: "bub-1person", ppl: people(1), notes: (p) => notesFor(p, [NOTES_SHORT[0]]) },
];

for (const sc of scenes) {
  const notes = sc.notes(sc.ppl);
  const layout = R.bubbleLayoutFor(rooms, sc.ppl, notes);
  const { ctx, buf } = makeCtx(2);
  R.drawVillage(ctx, sheet, rooms, sc.ppl);
  R.drawBubbles(ctx, sheet, layout);
  writePng(OUT + "/" + sc.name + ".png", W * 2, H * 2, buf);

  const overlaps = B.countOverlaps(layout.boxes);
  const outside = layout.boxes.filter((b) => b.x < 0 || b.y < 0 || b.x + b.w > W || b.y + b.h > H).length;
  const maxLines = Math.max(0, ...layout.boxes.map((b) => b.lines.length));
  const maxW = Math.max(0, ...layout.boxes.map((b) => b.w));
  console.log(sc.name + ": 人 " + sc.ppl.length + " / 吹き出し " + layout.boxes.length +
    " / 畳んだ人数 " + layout.hiddenCount + " / 重なり " + overlaps +
    " / はみ出し " + outside + " / 最大行数 " + maxLines + " / 最大幅 " + maxW + "px");
}
console.log("");
console.log("折り返しの確認（長文を14桁2行に収める）:");
console.log("  " + JSON.stringify(B.wrap(LONG, 14, 2)));
console.log("  半角混じり: " + JSON.stringify(B.wrap("ABC-1234 の設計レビューを 15:00 から", 14, 2)));
console.log("  絵文字: " + JSON.stringify(B.wrap("リリース🚀の準備と確認", 14, 2)));
