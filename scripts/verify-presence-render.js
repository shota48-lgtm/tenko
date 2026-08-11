const WebSocket = require("ws");
const path = require("path");
const R = require(process.argv[2] + "/compiled/render.js");
const fs = require("fs");
const sheet = JSON.parse(fs.readFileSync("src/sprites/variant-a.json", "utf8"));
const rooms = [{ id: 1, name: "オフィス" }, { id: 2, name: "会議室" }];
const t0 = Date.now();
const log = (s) => console.log("+" + ((Date.now() - t0) / 1000).toFixed(2) + "s  " + s);

const watcher = new WebSocket("ws://localhost:8080");
let latest = [];
watcher.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type !== "presence.list") return;
  latest = m.users;
  const spots = R.personSpots(rooms, latest);
  log("在席 " + latest.length + " 人 -> 描画位置 " + spots.map((s) => s.p.name + "(" + s.p.state + ")@" + s.x + "," + s.y).join(" / "));
});

const actor = new WebSocket("ws://localhost:8080");
actor.on("open", async () => {
  const send = (state, roomId) => actor.send(JSON.stringify({ type: "presence.set", user: { id: 9, name: "太郎", colorIndex: 1 }, state, roomId: roomId ?? null }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(400);
  log("--- 太郎を idle(広場) にする ---"); send("idle", null); await wait(500);
  log("--- 太郎を talking@部屋1 にする（建物の窓が光る条件） ---"); send("talking", 1); await wait(500);
  const lit = new Set(latest.filter((p) => p.state === "talking" && p.roomId != null).map((p) => p.roomId));
  log("窓を光らせる部屋: " + JSON.stringify([...lit]));
  log("--- 太郎を resting にする ---"); send("resting", null); await wait(500);
  log("--- 太郎を退勤(off) にする ---");
  actor.send(JSON.stringify({ type: "presence.set", user: { id: 9, name: "太郎", colorIndex: 1 }, state: "off" }));
  await wait(500);
  log("退勤後の描画人数: " + R.personSpots(rooms, latest).length);
  watcher.close(); actor.close(); process.exit(0);
});