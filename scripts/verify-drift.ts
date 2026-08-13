// 漂いの検証（T6・境界）。
//
// 目視では取りこぼす。**判定関数を毎フレーム呼んで、違反の回数を数える。**
// 漂いは決定的（乱数なし）なので、実時間を待たずに30秒分の全フレームを再現できる。
//
// 実行: npx tsx scripts/verify-drift.ts
// DB には接続しない。拠点と振幅は画面が出した実際の値（--plan）を渡す。
import { buildingForAvatar, hitFountain, buildingRects, PERSON_SIZE, VILLAGE_W, VILLAGE_H, type Room } from "../src/village/render";
import { driftOffset, safeAmplitude } from "../src/village/demo-drift";

// 画面（window.__driftPlan）から写した実際の値
const PLAN: [number, { anchorX: number; anchorY: number; amp: number }][] = JSON.parse(
  process.env.DRIFT_PLAN ?? "[]",
);
const ROOMS: Room[] = JSON.parse(process.env.DRIFT_ROOMS ?? "[]");

const FPS = 60;
const SECONDS = 30;
const t0 = 1_700_000_000_000;   // 固定の起点。決定的であることを確かめるため

let frames = 0;
let hitBuild = 0;
let hitFount = 0;
let outOfRange = 0;
const perId: Record<number, { minX: number; maxX: number; minY: number; maxY: number }> = {};

for (let f = 0; f < FPS * SECONDS; f++) {
  const t = t0 + Math.round((f * 1000) / FPS);
  for (const [id, d] of PLAN) {
    const { dx, dy } = driftOffset(id, safeAmplitude(ROOMS, d.anchorX, d.anchorY), t);
    const x = d.anchorX + dx;
    const y = d.anchorY + dy;
    frames++;
    if (buildingForAvatar(ROOMS, x, y)) hitBuild++;
    if (hitFountain(x + PERSON_SIZE / 2, y + PERSON_SIZE / 2)) hitFount++;
    if (x < 0 || y < 0 || x > VILLAGE_W - PERSON_SIZE || y > VILLAGE_H - PERSON_SIZE) outOfRange++;
    const r = (perId[id] ??= { minX: x, maxX: x, minY: y, maxY: y });
    r.minX = Math.min(r.minX, x); r.maxX = Math.max(r.maxX, x);
    r.minY = Math.min(r.minY, y); r.maxY = Math.max(r.maxY, y);
  }
}

console.log("建物の矩形（判定に使ったもの）: " + buildingRects(ROOMS).map((b) => `id=${b.room.id}(${b.x},${b.y})`).join(" "));
console.log(`検査したのべフレーム数: ${frames}（${PLAN.length}人 x ${FPS * SECONDS}フレーム）`);
console.log(`建物に重なった回数: ${hitBuild}`);
console.log(`噴水に重なった回数: ${hitFount}`);
console.log(`村の外に出た回数: ${outOfRange}`);
console.log("");
console.log("id ごとの拠点・振幅・30秒間の移動範囲:");
for (const [id, d] of PLAN) {
  const r = perId[id];
  const recomputed = safeAmplitude(ROOMS, d.anchorX, d.anchorY);
  console.log(
    `  id=${String(id).padStart(2)} 拠点(${String(d.anchorX).padStart(3)},${String(d.anchorY).padStart(3)}) A=${String(d.amp).padStart(2)}` +
    ` 再計算A=${String(recomputed).padStart(2)}${recomputed === d.amp ? "" : " ★不一致"}` +
    ` x ${r.minX}..${r.maxX} (幅${r.maxX - r.minX}) / y ${r.minY}..${r.maxY} (幅${r.maxY - r.minY})`,
  );
}

// 決定性の確認: 同じ id・同じ時刻を2回入れて、同じ値が出るか
const a = driftOffset(7, 40, t0 + 12345);
const b = driftOffset(7, 40, t0 + 12345);
console.log("");
console.log(`決定性: driftOffset(7,40,t) を2回 → ${JSON.stringify(a)} / ${JSON.stringify(b)} → ${a.dx === b.dx && a.dy === b.dy ? "一致" : "不一致"}`);
