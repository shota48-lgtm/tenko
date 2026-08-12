/* デモ用の利用者を仕立てる（Phase 5 段階5）。
   実行前に対象を表示し、--apply を付けたときだけ書き込む（J226）。
   実行: node scripts/seed-demo.js [--apply]
   戻す: node scripts/seed-demo.js --undo --apply

   方針（設計書・POの判断）:
     - 村に出すのは 20 人前後。22人までは重なり0を実測済み。56人は未実測
     - 残りは「メンバー一覧には出るが村にはいない」（is_demo だが demo_presence の行が無い）
     - 状態は混ぜる。全員が在席だと不自然
     - 建物の中にも入れる（会議中の表現と、建物の人数表示が見て分かる）
     - **id=1 は PO 本人。デモ用にしない**
     - **検証用の5人（検証 部下/上長/無関係/別上長/管理者）もデモ用にしない。**
       確認スクリプトがこの5人でログインするため（is_demo はログインできない） */
const fs = require("fs");
const { Client } = require("pg");
const geo = require("../ws-server/geometry");

const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const APPLY = process.argv.includes("--apply");
const UNDO = process.argv.includes("--undo");

// デモ用にしない人。PO本人と、確認スクリプトが使う5人
const KEEP_REAL_NAMES = ["検証 部下", "検証 上長", "検証 無関係", "検証 別上長", "検証 管理者"];
const KEEP_REAL_IDS = [1];

const VILLAGE_COUNT = 20;   // 村に出す人数

// 村に出す人の状態。20人分。全員が在席にならないように混ぜる。
//   room: 建物に入れる場合の「何番目の部屋か」（0 始まり）。null なら広場
const PLAN = [
  { state: "idle",    talk: "ok",    room: null, note: "見積もりの作成" },
  { state: "idle",    talk: "ok",    room: null, note: "朝会の準備" },
  { state: "idle",    talk: "later", room: null, note: "請求書のチェック" },
  { state: "idle",    talk: "focus", room: null, note: "設計書を書いています（15時まで集中）" },
  { state: "idle",    talk: "ok",    room: null, note: null },
  { state: "away",    talk: "ok",    room: null, note: "外出（14時に戻ります）" },
  { state: "away",    talk: "later", room: null, note: null },
  { state: "away",    talk: "ok",    room: null, note: "銀行へ" },
  { state: "resting", talk: "later", room: null, note: "昼休憩" },
  { state: "resting", talk: "ok",    room: null, note: null },
  { state: "idle",    talk: "focus", room: null, note: "資料作成に集中します" },
  { state: "idle",    talk: "ok",    room: null, note: "問い合わせの一次対応" },
  { state: "idle",    talk: "ok",    room: null, note: null },
  { state: "idle",    talk: "later", room: null, note: "月末の締め作業" },
  // ここから建物の中（会議中）。部屋の定員に収まる数にする
  { state: "talking", talk: "later", room: 0, note: "定例（10:00-11:00）" },
  { state: "talking", talk: "later", room: 0, note: null },
  { state: "talking", talk: "focus", room: 1, note: "採用面談" },
  { state: "talking", talk: "later", room: 1, note: null },
  { state: "talking", talk: "later", room: 2, note: "設計レビュー" },
  { state: "talking", talk: "later", room: 3, note: null },
];

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  if (UNDO) {
    console.log("戻す: demo_presence を空にし、is_demo をすべて false にする");
    if (!APPLY) { console.log("--apply が無いので実行しませんでした"); await db.end(); return; }
    const a = await db.query("DELETE FROM demo_presence");
    const b = await db.query("UPDATE users SET is_demo = false WHERE is_demo = true");
    console.log("demo_presence を " + a.rowCount + " 行削除 / is_demo を " + b.rowCount + " 人分戻した");
    await db.end();
    return;
  }

  // 部屋（建物の位置を出すために要る）
  const { rows: roomRows } = await db.query(
    `SELECT id, name, kind, capacity, deco FROM rooms WHERE deleted_at IS NULL ORDER BY id ASC`);
  const rooms = roomRows.map((r) => ({ id: Number(r.id), name: r.name, capacity: Number(r.capacity) }));
  const rects = geo.buildingRects(rooms);

  // デモ用にする人
  const { rows: all } = await db.query(
    `SELECT id, display_name, email FROM users WHERE deleted_at IS NULL ORDER BY id ASC`);
  const targets = all.filter(
    (u) => !KEEP_REAL_IDS.includes(Number(u.id))
        && !KEEP_REAL_NAMES.includes(u.display_name)
        && u.email === null);
  const skipped = all.filter((u) => !targets.includes(u));

  console.log("デモ用にする: " + targets.length + " 人");
  console.log("デモ用にしない: " + skipped.map((u) => u.id + ":" + u.display_name).join(", "));
  console.log("そのうち村に出す: " + Math.min(VILLAGE_COUNT, targets.length) + " 人");

  const inVillage = targets.slice(0, VILLAGE_COUNT);
  const placed = [];
  let plazaIndex = 0;
  const usedSpots = [];

  for (let i = 0; i < inVillage.length; i++) {
    const u = inVillage[i];
    const plan = PLAN[i % PLAN.length];
    let x, y, roomId = null;

    if (plan.room != null && rects[plan.room]) {
      // 建物の中。建物の中心に置く（buildingAt が中心で判定するため）
      const r = rects[plan.room];
      // 同じ部屋の人を少しずらす。重ねると下の人を選べない
      const n = placed.filter((p) => p.roomId === Number(r.room.id)).length;
      const c = geo.clamp(r.x + r.w / 2 - geo.PERSON_SIZE / 2 + (n % 2) * 6 - 3,
                          r.y + r.h / 2 - geo.PERSON_SIZE / 2 + Math.floor(n / 2) * 6 - 3);
      x = c.x; y = c.y; roomId = Number(r.room.id);
    } else {
      // 広場。空いている場所を使う。建物と噴水の上は避ける。
      //
      // geo.SPOTS は「村の中心に近い順」に並んでいる。順に取ると全員が中心に固まり、
      // 村の上半分が空のままになる（実機で確認）。実際の職場でも人は散っている。
      // 間隔を空けて取ることで、村全体に散らばらせる
      const STRIDE = 7;
      for (;;) {
        const s = geo.defaultSpot((plazaIndex++) * STRIDE);
        if (geo.buildingAt(rooms, s.x, s.y)) continue;
        if (geo.onFountain(s.x, s.y)) continue;
        if (usedSpots.some((p) => Math.abs(p.x - s.x) < geo.PERSON_SIZE && Math.abs(p.y - s.y) < geo.PERSON_SIZE)) continue;
        x = s.x; y = s.y;
        usedSpots.push({ x, y });
        break;
      }
    }
    placed.push({
      id: Number(u.id), name: u.display_name, state: plan.state, talk: plan.talk,
      roomId, x, y, colorIndex: ((Number(u.id) - 1) % 4) + 1, note: plan.note,
    });
  }

  console.log("\n村に出す内訳:");
  const byState = {};
  for (const p of placed) byState[p.state] = (byState[p.state] || 0) + 1;
  console.log("  状態: " + Object.entries(byState).map(([k, v]) => k + " " + v + "人").join(" / "));
  const byTalk = {};
  for (const p of placed) byTalk[p.talk] = (byTalk[p.talk] || 0) + 1;
  console.log("  話しかけて: " + Object.entries(byTalk).map(([k, v]) => k + " " + v + "人").join(" / "));
  console.log("  今日やること: あり " + placed.filter((p) => p.note).length + "人 / なし " + placed.filter((p) => !p.note).length + "人");
  for (const r of rooms) {
    const n = placed.filter((p) => p.roomId === r.id).length;
    if (n > 0) console.log("  「" + r.name + "」に " + n + "人（定員 " + r.capacity + "）");
  }

  if (!APPLY) {
    console.log("\n--apply を付けていないため書き込みませんでした");
    await db.end();
    return;
  }

  await db.query(`UPDATE users SET is_demo = true WHERE id = ANY($1)`, [targets.map((u) => Number(u.id))]);
  await db.query("DELETE FROM demo_presence");
  for (const p of placed) {
    await db.query(
      `INSERT INTO demo_presence (user_id, state, talk, room_id, x, y, color_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [p.id, p.state, p.talk, p.roomId, p.x, p.y, p.colorIndex],
    );
    if (p.note) {
      await db.query(
        `INSERT INTO daily_notes (user_id, note_date, body)
         VALUES ($1, (now() AT TIME ZONE 'Asia/Tokyo')::date, $2)
         ON CONFLICT (user_id, note_date) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
        [p.id, p.note],
      );
    }
  }
  const n = (await db.query("SELECT count(*)::int n FROM demo_presence")).rows[0].n;
  const m = (await db.query("SELECT count(*)::int n FROM users WHERE is_demo")).rows[0].n;
  console.log("\n書き込んだ: demo_presence " + n + " 行 / is_demo " + m + " 人");
  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
