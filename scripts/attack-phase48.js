/* 審査役A（Phase 4.8）: 移動・定員・呼びかけに攻撃を実際に送る。
   - 他人のアバターを移動できないこと
   - 不正な座標（村の外・負の数・極端な値・数値でない値）を拒否するか収めること
   - 定員を超えて建物に入れないこと（APIを直接叩いても）
   - 他人になりすまして呼びかけを送れないこと
   - 呼びかけの連打を防げること
   実行: node scripts\attack-phase48.js */
const WebSocket = require("ws");
const geo = require("../ws-server/geometry");
const API = "http://localhost:3000";
const log = (s) => console.log(s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 接続を開き、届いたメッセージを溜める
function open(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket("ws://localhost:8080");
    ws.got = [];
    ws.on("message", (d) => { try { ws.got.push(JSON.parse(d.toString())); } catch {} });
    ws.on("open", () => resolve(ws));
    ws.label = name;
  });
}
const last = (ws, type) => [...ws.got].reverse().find((m) => m.type === type);
function stateOf(ws, id) {
  const l = last(ws, "presence.list");
  return l ? l.users.find((u) => Number(u.id) === Number(id)) : undefined;
}

(async () => {
  const roomsRes = await (await fetch(API + "/api/rooms")).json();
  const rects = geo.buildingRects(roomsRes.rooms);
  const house = rects[0];
  // 足元が枠に入る位置
  const inside = (b, i) => ({ x: b.x + ((i % 3) - 1) * 5, y: b.y - 12 });

  const watcher = await open("見張り");
  // 被害者と攻撃者を用意する。IDは実在しない番号でよい（在席は名乗り制のため）
  const VICTIM = 9001;
  const ATTACKER = 9002;
  const victim = await open("被害者");
  victim.send(JSON.stringify({ type: "presence.set", user: { id: VICTIM, name: "被害者", colorIndex: 1 }, state: "idle", talk: "ok" }));
  const attacker = await open("攻撃者");
  attacker.send(JSON.stringify({ type: "presence.set", user: { id: ATTACKER, name: "攻撃者", colorIndex: 2 }, state: "idle", talk: "ok" }));
  await wait(500);
  watcher.send(JSON.stringify({ type: "presence.sync" }));
  await wait(300);

  const before = stateOf(watcher, VICTIM);
  log("被害者の位置（攻撃前）: " + JSON.stringify({ x: before.x, y: before.y, state: before.state, roomId: before.roomId }));

  log("");
  log("=== 1. 他人のアバターを移動させる ===");
  // 利用者IDを添えて送る／被害者になりすました presence.move を送る、の両方を試す
  const tries = [
    { type: "presence.move", x: 10, y: 10, user: { id: VICTIM } },
    { type: "presence.move", x: 20, y: 20, userId: VICTIM },
    { type: "presence.move", x: 30, y: 30, id: VICTIM, to: VICTIM },
  ];
  for (const t of tries) attacker.send(JSON.stringify(t));
  await wait(500);
  watcher.send(JSON.stringify({ type: "presence.sync" }));
  await wait(300);
  const afterVictim = stateOf(watcher, VICTIM);
  const afterAttacker = stateOf(watcher, ATTACKER);
  log("  被害者の位置（攻撃後）: " + JSON.stringify({ x: afterVictim.x, y: afterVictim.y }));
  log("  攻撃者の位置（攻撃後）: " + JSON.stringify({ x: afterAttacker.x, y: afterAttacker.y }));
  log("  被害者が動いたか: " + (afterVictim.x !== before.x || afterVictim.y !== before.y ? "動いた（問題）" : "動いていない"));
  log("  → presence.move は座標だけを持ち、届いた接続の人にしか適用しない。添えたIDは読まれない");

  log("");
  log("=== 2. 不正な座標 ===");
  const bad = [
    ["村の外（右下）", 99999, 99999],
    ["負の数", -500, -500],
    ["極端に大きい値", 1e18, 1e18],
    ["無限大", Infinity, 0],
    ["NaN", NaN, 0],
    ["文字列", "10", "20"],
    ["null", null, null],
    ["配列", [1], [2]],
  ];
  for (const [name, x, y] of bad) {
    attacker.got.length = 0;
    attacker.send(JSON.stringify({ type: "presence.move", x, y }));
    await wait(250);
    watcher.send(JSON.stringify({ type: "presence.sync" }));
    await wait(250);
    const s = stateOf(watcher, ATTACKER);
    const denied = last(attacker, "presence.denied");
    const inRange = s.x >= 0 && s.y >= 0 && s.x <= geo.VILLAGE_W - geo.PERSON_SIZE && s.y <= geo.VILLAGE_H - geo.PERSON_SIZE;
    log(`  ${name.padEnd(14, "　")} -> 位置=(${s.x},${s.y}) 村の中=${inRange ? "はい" : "いいえ（問題）"}` +
      (denied ? " / 断り=" + denied.reason : ""));
  }
  log("  村の大きさ: " + geo.VILLAGE_W + "x" + geo.VILLAGE_H + " / 人物 " + geo.PERSON_SIZE);

  log("");
  log("=== 3. 定員を超えて建物に入る ===");
  const cap = roomsRes.rooms.find((r) => Number(r.id) === Number(house.room.id)).capacity;
  log("  対象: 「" + house.room.name + "」 定員=" + cap);
  const fillers = [];
  for (let i = 0; i < cap; i++) {
    const ws = await open("詰める" + i);
    ws.send(JSON.stringify({ type: "presence.set", user: { id: 9100 + i, name: "詰める" + i, colorIndex: 1 }, state: "idle", talk: "ok" }));
    await wait(80);
    const t = inside(house, i);
    ws.send(JSON.stringify({ type: "presence.move", x: t.x, y: t.y }));
    fillers.push(ws);
    await wait(80);
  }
  await wait(400);
  watcher.send(JSON.stringify({ type: "presence.sync" }));
  await wait(300);
  const filled = last(watcher, "presence.list").rooms[house.room.id];
  log("  詰めた結果: " + filled.used + "/" + filled.capacity);

  attacker.got.length = 0;
  const t = inside(house, 1);
  attacker.send(JSON.stringify({ type: "presence.move", x: t.x, y: t.y }));
  await wait(400);
  watcher.send(JSON.stringify({ type: "presence.sync" }));
  await wait(300);
  const afterFull = stateOf(watcher, ATTACKER);
  const deniedFull = last(attacker, "presence.denied");
  log("  満員の建物へ入ろうとした結果: roomId=" + afterFull.roomId + " state=" + afterFull.state);
  log("  返ってきた断り: " + (deniedFull ? deniedFull.reason : "なし（問題）"));
  const after2 = last(watcher, "presence.list").rooms[house.room.id];
  log("  部屋の人数: " + after2.used + "/" + after2.capacity + "（定員を超えていないこと）");

  log("");
  log("=== 4. 他人になりすまして呼びかける ===");
  victim.got.length = 0;
  // from を詐称して送る。サーバーは接続から発信元を決めるため、詐称は反映されないはず
  attacker.send(JSON.stringify({ type: "call.invite", to: VICTIM, from: { id: VICTIM, name: "社長" } }));
  await wait(400);
  const inc = last(victim, "call.incoming");
  log("  被害者に届いた呼びかけ: " + JSON.stringify(inc ? inc.from : null));
  log("  詐称した名前「社長」になっているか: " + (inc && inc.from.name === "社長" ? "なっている（問題）" : "なっていない"));

  log("");
  log("=== 5. 呼びかけの連打 ===");
  attacker.got.length = 0;
  for (let i = 0; i < 15; i++) attacker.send(JSON.stringify({ type: "call.invite", to: VICTIM }));
  await wait(800);
  const sent = attacker.got.filter((m) => m.type === "call.sent").length;
  const refused = attacker.got.filter((m) => m.type === "call.denied");
  log("  15回連続で送った結果: 通った=" + sent + " 断られた=" + refused.length);
  log("  断りの理由（先頭）: " + (refused[0] ? refused[0].reason : "なし（問題）"));

  log("");
  log("=== 6. 許可されていない種別（回帰）===");
  attacker.got.length = 0;
  for (const type of ["message.created", "presence.setx", "call", "admin.grant", "rooms.update"]) {
    attacker.send(JSON.stringify({ type, message: { id: 1, room_id: 1, body: "偽" } }));
  }
  await wait(400);
  log("  何か返ってきたか: " + (attacker.got.length ? JSON.stringify(attacker.got) : "何も返ってこない（捨てられている）"));

  log("");
  log("=== 7. HTTP 側に位置・定員を書き換える口があるか ===");
  for (const path of ["/api/presence", "/api/rooms", "/api/village/move"]) {
    for (const method of ["POST", "PUT", "PATCH"]) {
      const r = await fetch(API + path, {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: 0, y: 0, capacity: 999, user: VICTIM }),
      });
      if (r.status !== 404 && r.status !== 405) log("  " + method + " " + path + " -> " + r.status + "（口がある。中身を確認すること）");
    }
  }
  log("  405/404 以外が出なければ、書き換える口は無い");
  const capNow = (await (await fetch(API + "/api/rooms")).json()).rooms.find((r) => Number(r.id) === Number(house.room.id)).capacity;
  log("  定員は変わっていないか: " + cap + " -> " + capNow);

  for (const ws of [watcher, victim, attacker, ...fillers]) ws.close();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
