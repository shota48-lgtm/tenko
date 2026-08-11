// 作業6-8/6-10 の検証: 在席状態が他のクライアントに反映されるか、再接続で取り直せるか
const WebSocket = require("ws");
const t0 = Date.now();
const log = (s) => console.log("+" + ((Date.now() - t0) / 1000).toFixed(2) + "s  " + s);

function viewer(name, user) {
  const v = { name, user, list: [], state: "初期", delay: 500, stopped: false, lastState: "idle" };
  const connect = () => {
    v.ws = new WebSocket("ws://localhost:8080");
    v.ws.on("open", () => {
      v.delay = 500; v.state = "接続中"; log("[" + name + "] 接続");
      // 画面と同じく、再接続したら自分の状態を申告し直す
      v.ws.send(JSON.stringify({ type: "presence.set", user, state: v.lastState, roomId: v.lastRoom ?? null }));
    });
    v.ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "presence.list") {
        v.list = m.users;
        log("[" + name + "] 一覧を受信: " + m.users.map((u) => u.name + "=" + u.state + (u.roomId ? "@部屋" + u.roomId : "")).join(", ") || "(空)");
      }
    });
    v.ws.on("error", () => {});
    v.ws.on("close", () => {
      if (v.stopped) return;
      v.state = "切断"; log("[" + name + "] 切断 -> " + v.delay + "ms 後に再接続");
      setTimeout(() => { v.delay = Math.min(v.delay * 2, 2000); connect(); }, v.delay);
    });
  };
  v.set = (state, roomId) => { v.lastState = state; v.lastRoom = roomId ?? null;
    if (v.ws.readyState === 1) v.ws.send(JSON.stringify({ type: "presence.set", user, state, roomId: roomId ?? null })); };
  connect();
  return v;
}

(async () => {
  const A = viewer("タブA", { id: 1, name: "太郎", colorIndex: 1 });
  const B = viewer("タブB", { id: 2, name: "花子", colorIndex: 2 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(800);

  log("--- 6-8: Aが会話中(部屋1)に変更 ---");
  A.set("talking", 1);
  await wait(600);
  const seen = B.list.find((u) => u.id === 1);
  log("結果: Bから見たAの状態 = " + (seen ? seen.state + " / 部屋 " + seen.roomId : "見えない"));

  log("--- 投稿をWS経由で送っても破棄されるか（設計方針の破壊試験） ---");
  A.ws.send(JSON.stringify({ type: "message.created", message: { id: 999, room_id: 1, body: "WS経由の偽投稿" } }));
  await wait(500);
  log("結果: Bが偽投稿を受け取ったか = " + (B.gotFake ? "受け取った(異常)" : "受け取っていない"));

  log("--- 6-10: ws-server を止めて再起動する（PowerShell 側が操作） ---");
  await wait(14000);
  log("Aの状態=" + A.state + " / Bの状態=" + B.state);
  log("再接続後にBが持っている一覧: " + B.list.map((u) => u.name + "=" + u.state + (u.roomId ? "@部屋" + u.roomId : "")).join(", "));
  log("再接続後にAが持っている一覧: " + A.list.map((u) => u.name + "=" + u.state).join(", "));

  log("--- 退勤(off)で村から消えるか ---");
  A.ws.send(JSON.stringify({ type: "presence.set", user: { id: 1, name: "太郎", colorIndex: 1 }, state: "off" }));
  await wait(500);
  log("結果: Bの一覧 = " + (B.list.map((u) => u.name).join(", ") || "(空)"));

  A.stopped = true; B.stopped = true; A.ws.close(); B.ws.close();
  process.exit(0);
})();