// tenko WebSocket サーバー（通知路 + 在席状態 + 位置 + 呼びかけ）
//
// 設計方針（spike/ws-01 の実測にもとづき固定。崩さないこと）:
//   - ここでデータを保存しない。チャットの投稿は HTTP + DB を正とする
//   - 勤怠は一切ここを通さない
//   - 在席状態と位置はこのサーバーの揮発メモリだけで持つ。DBには保存しない
//     （失っても再接続時に取り直せるため）
//
// Phase 4.8 で「位置が状態を決める」形に変わった:
//   建物に入れば会議中になり、広場に出れば元の状態に戻る。
//   この判定はここで行う。画面側の判定だけでは、WS を直接叩けば通ってしまう。
//
// なりすまし対策の要点:
//   移動・呼びかけの発信元は「そのWebSocket接続に紐づく人」から取る。
//   メッセージ本文の利用者IDは読まない。よって他人のアバターは動かせない。
//   （presence.set で他人のIDを名乗れる点は、認証が未実装であることに由来する既知の穴。S6）

const { WebSocketServer } = require("ws");
const geo = require("./geometry");

const PORT = Number(process.env.PORT) || 8080;
const NOTIFY_TOKEN = process.env.WS_NOTIFY_TOKEN || "dev-notify-token";
const API = process.env.TENKO_API || "http://localhost:3000";

// 画面（viewer）から受け付ける種別。src/lib/ws-messages.ts の VIEWER_ALLOWED と対応させる。
// 前方一致で見るので、名前空間ごと許可できる
const VIEWER_ALLOWED = ["presence.set", "presence.sync", "presence.move", "call."];

const wss = new WebSocketServer({ port: PORT });
const presence = new Map();   // ws -> { id, name, colorIndex, state, baseState, talk, roomId, x, y }

// 部屋の一覧（定員つき）。定員をサーバー側で判定するために持つ。
// 取れていない間は「建物に入れない」側に倒す（分からないときに通さない）
let rooms = [];
let roomsLoadedAt = 0;

async function loadRooms() {
  try {
    const res = await fetch(API + "/api/rooms");
    if (!res.ok) throw new Error("status " + res.status);
    const d = await res.json();
    rooms = Array.isArray(d.rooms) ? d.rooms : [];
    roomsLoadedAt = Date.now();
    console.log("[rooms] " + rooms.length + " 件を取得した");
  } catch (e) {
    console.log("[rooms] 取得できなかった: " + e.message + "（建物には入れない扱いにする）");
  }
}
loadRooms();
setInterval(loadRooms, 60_000);

function capacityOf(roomId) {
  const r = rooms.find((x) => Number(x.id) === Number(roomId));
  return r && Number.isFinite(Number(r.capacity)) ? Number(r.capacity) : 0;
}
// その部屋にいる人数。同じ利用者の複数接続は1人として数える
function occupantsOf(roomId, exceptUserId) {
  const ids = new Set();
  for (const p of presence.values()) {
    if (Number(p.roomId) === Number(roomId) && p.id !== exceptUserId) ids.add(p.id);
  }
  return ids.size;
}

// 同じ利用者が複数の端末・タブから接続していても、村では1人として扱う。
// どの接続を採用するか: 最後に状態を申告した接続。
//   理由: 手元で操作している端末が最後に申告する。放置された古い端末の状態で上書きされない。
function presenceList() {
  const byUser = new Map();
  for (const p of presence.values()) {
    const prev = byUser.get(p.id);
    if (!prev || (p.updatedAt || 0) >= (prev.updatedAt || 0)) byUser.set(p.id, p);
  }
  const out = [];
  for (const p of byUser.values()) {
    let connections = 0;
    for (const q of presence.values()) if (q.id === p.id) connections++;
    out.push({
      id: p.id, name: p.name, colorIndex: p.colorIndex,
      state: p.state, roomId: p.roomId, talk: p.talk, x: p.x, y: p.y, connections,
    });
  }
  return out;
}
function roomCounts() {
  const out = {};
  for (const r of rooms) out[r.id] = { used: occupantsOf(r.id, null), capacity: capacityOf(r.id) };
  return out;
}
function broadcast(obj) {
  const text = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (!c.isNotifier && c.readyState === 1) c.send(text);
  }
}

// 移動は連続して届く。1件ごとに全員へ配ると、20人で通信量が跳ね上がる。
// 50ms にまとめて配る（1秒あたり最大20回）。人が増えても配信回数は増えない
let listTimer = null;
function sendList(immediate) {
  if (immediate) {
    if (listTimer) { clearTimeout(listTimer); listTimer = null; }
    broadcast({ type: "presence.list", users: presenceList(), rooms: roomCounts() });
    return;
  }
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    broadcast({ type: "presence.list", users: presenceList(), rooms: roomCounts() });
  }, 50);
}

// 利用者ID -> その人の接続。呼びかけを特定の相手だけに届けるために使う
function socketsOf(userId) {
  const out = [];
  for (const [ws, p] of presence) if (p.id === Number(userId) && ws.readyState === 1) out.push(ws);
  return out;
}

// 呼びかけの連打を防ぐ。接続ごとに、同じ相手へは5秒あけ、全体で1分あたり10件まで
const INVITE_GAP_MS = 5_000;
const INVITE_PER_MIN = 10;
function canInvite(ws, to) {
  const now = Date.now();
  ws.invites = (ws.invites || []).filter((t) => now - t.at < 60_000);
  if (ws.invites.some((t) => t.to === to && now - t.at < INVITE_GAP_MS)) {
    return "同じ相手への呼びかけは5秒あけてください";
  }
  if (ws.invites.length >= INVITE_PER_MIN) {
    return "呼びかけが多すぎます。1分あたり10件までです";
  }
  ws.invites.push({ to, at: now });
  return null;
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", "http://localhost");
  ws.isNotifier =
    url.searchParams.get("role") === "notifier" &&
    url.searchParams.get("token") === NOTIFY_TOKEN;

  console.log("[open] " + (ws.isNotifier ? "notifier" : "viewer") + " clients=" + wss.clients.size);

  if (!ws.isNotifier) {
    ws.send(JSON.stringify({ type: "presence.list", users: presenceList(), rooms: roomCounts() }));
  }

  ws.on("message", (data) => {
    const text = data.toString();
    if (ws.isNotifier) {
      console.log("[notify] " + text.slice(0, 120));
      broadcast(JSON.parse(text));
      return;
    }
    // 画面側から受け付ける種別は、この許可リストにあるものだけ。
    // 一覧は src/lib/ws-messages.ts の VIEWER_ALLOWED と対応させること
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const allowed = typeof msg?.type === "string" && VIEWER_ALLOWED.some((p) => msg.type === p || msg.type.startsWith(p));
    if (!allowed) {
      console.log("[drop] viewer からの " + (msg && msg.type) + " を破棄した");
      return;
    }

    if (msg.type === "presence.set") {
      const u = msg.user || {};
      if (msg.state === "off") { presence.delete(ws); sendList(true); return; }
      const prev = presence.get(ws);
      const state = ["idle", "away", "talking", "resting"].indexOf(msg.state) >= 0 ? msg.state : "idle";
      // 位置がまだ無い人にだけ初期値を与える。以後はその人の座標が正
      const spot = prev ? { x: prev.x, y: prev.y } : geo.defaultSpot(presence.size);
      presence.set(ws, {
        id: Number(u.id) || 0,
        // 名前も他人の画面に出るため、長さを切る。中継しかしないサーバー側でも防ぐ
        name: String(u.name || "名無し").slice(0, 40),
        colorIndex: Number(u.colorIndex) || 1,
        // 建物の中にいるなら会議中のまま。位置が状態を決める（Phase 4.8）
        state: prev && prev.roomId != null ? "talking" : state,
        // 建物から出たときに戻す状態。会議中は「位置が決めた状態」なので控えに入れない
        baseState: state === "talking" ? (prev?.baseState ?? "idle") : state,
        roomId: prev ? prev.roomId : null,
        x: spot.x, y: spot.y,
        // 話しかけてよいか。決められた3つ以外は受け取らない
        talk: ["ok", "later", "focus"].indexOf(msg.talk) >= 0 ? msg.talk : "ok",
        updatedAt: Date.now(),
      });
      sendList(true);

    } else if (msg.type === "presence.move") {
      // 動かせるのは「この接続の人」だけ。メッセージの中の利用者IDは読まない。
      // これが他人のアバターを動かせないことの担保になっている
      const p = presence.get(ws);
      if (!p) { ws.send(JSON.stringify({ type: "presence.denied", reason: "村にいません" })); return; }
      if (!geo.isCoord(msg.x) || !geo.isCoord(msg.y)) {
        console.log("[drop] 座標として読めない move を破棄した: " + JSON.stringify([msg.x, msg.y]));
        ws.send(JSON.stringify({ type: "presence.denied", reason: "座標が不正です" }));
        return;
      }
      // 村の外・負の数・極端な値は、拒否ではなく村の中に収める（操作が止まらないように）
      const at = geo.clamp(msg.x, msg.y);
      const b = geo.buildingAt(rooms, at.x, at.y);

      if (b) {
        const roomId = Number(b.room.id);
        if (Number(p.roomId) !== roomId) {
          const cap = capacityOf(roomId);
          const used = occupantsOf(roomId, p.id);
          if (cap <= 0) {
            ws.send(JSON.stringify({ type: "presence.denied", reason: "部屋の情報が取れていないため入れません" }));
            return;
          }
          if (used >= cap) {
            // 定員はサーバー側で判定する。画面側の判定だけでは直接叩かれれば通る
            ws.send(JSON.stringify({
              type: "presence.denied", roomId,
              reason: "「" + b.room.name + "」は満員です（" + used + "/" + cap + "）",
            }));
            return;
          }
        }
        p.roomId = roomId;
        p.state = "talking";   // 建物に入ると会議中。状態のメニューからは選べない
      } else {
        p.roomId = null;
        // 建物から出たら、入る前の状態に戻す
        if (p.state === "talking") p.state = p.baseState || "idle";
      }
      p.x = at.x;
      p.y = at.y;
      p.updatedAt = Date.now();
      sendList(false);

    } else if (msg.type === "presence.sync") {
      ws.send(JSON.stringify({ type: "presence.list", users: presenceList(), rooms: roomCounts() }));

    } else if (msg.type === "call.invite") {
      // 呼びかけ。通話は繋がない（Phase 4.8 では「いま話せますか」を伝えるところまで）。
      // 発信元はこの接続の人。メッセージの中の from は読まないため、なりすませない
      const from = presence.get(ws);
      if (!from) return;
      const to = Number(msg.to);
      if (!Number.isInteger(to) || to <= 0 || to === from.id) return;
      const limited = canInvite(ws, to);
      if (limited) { ws.send(JSON.stringify({ type: "call.denied", reason: limited })); return; }
      const targets = socketsOf(to);
      if (targets.length === 0) {
        ws.send(JSON.stringify({ type: "call.denied", reason: "相手は村にいません" }));
        return;
      }
      const payload = JSON.stringify({
        type: "call.incoming",
        from: { id: from.id, name: from.name },
        // 呼びかけた側が相手の「話しかけて」を分かったうえで押したか。相手側の表示に使う
        knewFocus: msg.knewFocus === true,
      });
      for (const t of targets) t.send(payload);
      ws.send(JSON.stringify({ type: "call.sent", to }));

    } else if (msg.type === "call.respond") {
      const from = presence.get(ws);
      if (!from) return;
      const to = Number(msg.to);
      if (!Number.isInteger(to) || to <= 0) return;
      const answer = msg.answer === "accept" ? "accept" : msg.answer === "later" ? "later" : "decline";
      const payload = JSON.stringify({
        type: "call.answered", from: { id: from.id, name: from.name }, answer,
      });
      for (const t of socketsOf(to)) t.send(payload);
    }
  });

  ws.on("close", () => {
    if (presence.delete(ws)) sendList(true);
    console.log("[close] clients=" + wss.clients.size);
  });
});

console.log("ws-server listening on port " + PORT + " / API=" + API);
