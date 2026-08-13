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
//
// Phase 5 段階6 で S6（他人の在席を偽装できる）を塞いだ:
//   接続するには入場券が要る。**利用者IDは券から取り、接続に紐づける。**
//   presence.set が名乗る user.id は読まない。券の無い接続は「見るだけ」で、
//   presence に入らず、送ってきたメッセージは種別を問わず全て捨てる。
//
//   券の検証は handleProtocols で行うが、**そこでは断らない**。
//   handleProtocols が false を返しても ws は connection を発生させるうえ、
//   ブラウザには close code が届かず 1006 になる（spike/ws-auth-01 で実測）。
//   判定は覚えるだけにし、断るのは connection の中で close(4003) / close(4004) による。

const http = require("http");
const { WebSocketServer } = require("ws");
const geo = require("./geometry");
const { verifyTicket } = require("./ticket");

// 手元で動かすときだけ、アプリ側の .env.local から鍵を借りる。
// 本番（Railway）では環境変数が直接設定されるため、この読み込みは何もしない。
// **既に環境変数がある場合は上書きしない。**
(function loadLocalEnv() {
  try {
    const fs = require("fs");
    const path = require("path");
    const p = path.join(__dirname, "..", ".env.local");
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i <= 0 || line.trimStart().startsWith("#")) continue;
      const k = line.slice(0, i).trim();
      if (!k.startsWith("TENKO_")) continue;          // アプリ専用の鍵は読まない
      if (process.env[k] !== undefined) continue;
      process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* 読めなくても本番には影響しない */ }
})();

const PORT = Number(process.env.PORT) || 8080;
const NOTIFY_TOKEN = process.env.WS_NOTIFY_TOKEN || "dev-notify-token";
const API = process.env.TENKO_API || "http://localhost:3000";
const INTERNAL_TOKEN = process.env.TENKO_WS_INTERNAL_TOKEN || "";
// 見るだけモード。0 のときは券の無い接続を受けない
const PUBLIC_VIEW = (process.env.TENKO_PUBLIC_VIEW ?? "1") === "1";

// 無効化の定期確認が続けて失敗したときの段階（設計書6節）
const VERIFY_FAIL_WARN = 5;    // 5回（約5分）で警告に上げる
const VERIFY_FAIL_CUT = 10;    // 10回（約10分）で認証済みの接続を全て切る
// 確認の間隔。既定は60秒。
// **確認スクリプトから短くできるようにしてある**（10回の失敗を10分待たずに確かめるため）
const VERIFY_INTERVAL_MS = Number(process.env.TENKO_WS_VERIFY_INTERVAL_MS) || 60_000;

// 画面（viewer）から受け付ける種別。src/lib/ws-messages.ts の VIEWER_ALLOWED と対応させる。
// 前方一致で見るので、名前空間ごと許可できる
const VIEWER_ALLOWED = ["presence.set", "presence.sync", "presence.move", "call."];

// 接続ごとの判定を、handleProtocols から connection へ渡すための控え。
// request をキーにする（同じリクエストが connection にも渡ってくる）
const pendingAuth = new Map();

// HTTP のサーバーを自分で持ち、その上に WebSocket を載せる（Phase 5 段階7）。
//
// なぜ必要か: Render の無料枠は「HTTPで応答すること」を見て生死を判定する。
//   WebSocketServer に port を渡す形だと、普通のHTTPには 400 しか返さず、
//   健康確認に落ちる。/healthz を返す口を用意しておく。
//   **HTTPの受信も停止の先送りになる**ので、起こす経路が1つ増える意味もある。
const httpServer = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    // 中身に意味は持たせない。動いているかどうかだけを返す
    res.end("ok " + wss.clients.size);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("tenko ws-server");
});

const wss = new WebSocketServer({
  server: httpServer,
  // **ここでは断らない。判定して覚えるだけ。**（設計書6節。spike/ws-auth-01 の実測にもとづく）
  //
  // 応答は常に "tenko.v1" を返す。券は返さない。
  //   券を返しても接続は成立するが、券が応答ヘッダに載って返ることになる。
  //   券をURLに載せない理由（経路のログに残る）と同じ理由で、応答にも載せない。
  //   なお **何も返さない（false）とブラウザは 1006 で切る。** 応答は必ず返すこと
  handleProtocols: (protocols, request) => {
    const list = [...protocols];
    const raw = list.find((p) => typeof p === "string" && p.startsWith("ticket."));
    if (!raw) {
      pendingAuth.set(request, { authed: false, why: "券なし（見るだけ）", hadTicket: false });
    } else {
      let v;
      try { v = verifyTicket(raw.slice("ticket.".length)); }
      catch (e) { v = { ok: false, why: "検証できない: " + e.message }; }
      pendingAuth.set(request, v.ok
        ? { authed: true, userId: v.userId, sessionId: v.sessionId, why: "OK", hadTicket: true }
        : { authed: false, why: v.why, hadTicket: true });
    }
    // 画面が protocols を1つも送ってこない場合、この関数は呼ばれない。
    // その接続は connection 側で「券なし」として扱う（下の既定値）
    return "tenko.v1";
  },
});
const presence = new Map();   // ws -> { id, name, colorIndex, state, baseState, talk, roomId, x, y }

// 部屋の一覧（定員つき）。定員をサーバー側で判定するために持つ。
// 取れていない間は「建物に入れない」側に倒す（分からないときに通さない）
let rooms = [];
let roomsLoadedAt = 0;

// デモ用の利用者（Phase 5 段階5）。
//
// 接続を持たないが、常に村にいる人。村が空だと、見るだけで開いた人に何も伝わらないため。
// **デモ用のプロセスは動かさない。** Railway の枠を消費し、落ちれば村が空になる。
// 代わりに、この一覧をアプリから60秒ごとに取り、実際の接続に足して配る。
let demo = [];

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

async function loadDemo() {
  try {
    const res = await fetch(API + "/api/demo-presence");
    if (!res.ok) throw new Error("status " + res.status);
    const d = await res.json();
    // 取れたときだけ入れ替える。取れなかったら前の内容を使い続ける
    // （一時的に取れないだけで村が空になると、見るだけの人には壊れて見える）
    if (Array.isArray(d.demo)) {
      demo = d.demo;
      console.log("[demo] " + demo.length + " 人を村に出す");
    }
  } catch (e) {
    console.log("[demo] 取得できなかった: " + e.message + "（前の内容をそのまま使う）");
  }
}

// 無効化の定期確認（Phase 5 段階6）。
//
// **/api/demo-presence とは1本にまとめない**（PO判断）。
// 周期は同じでも、失敗したときの扱いが逆であるため:
//   demo-presence の失敗 → 前回の内容を使い続ける（村が空にならないように）
//   ws-verify の失敗     → 段階的に切断する（無効化の仕組みが死んだままにならないように）
// まとめると、片方の障害がもう片方を巻き込む。
let verifyFails = 0;        // 連続で失敗した回数
let verifyBlocked = false;  // 確認が続けて失敗し、認証済みとして扱うのをやめている状態

// 認証済みの接続を全て見るだけに落とし、切る
function cutAllAuthed(reason) {
  let n = 0;
  for (const c of wss.clients) {
    if (c.authed !== true) continue;
    presence.delete(c);
    c.authed = false;
    try {
      c.send(JSON.stringify({ type: "auth.expired", reason }));
      c.close(4001, reason);
    } catch { /* 既に閉じている */ }
    n++;
  }
  if (n > 0) sendList(true);
  return n;
}

async function verifySessions() {
  // いま繋がっている認証済みの接続の、セッションの行id
  const bySession = new Map();   // sessionId -> [ws, ...]
  for (const c of wss.clients) {
    if (c.authed !== true || !c.sessionId) continue;
    if (!bySession.has(c.sessionId)) bySession.set(c.sessionId, []);
    bySession.get(c.sessionId).push(c);
  }
  if (bySession.size === 0) {
    // **認証済みの接続が0本のときは投げない**（PO判断。Phase 5 段階7）。
    //   確認する対象が無いときに確認する意味がない。
    //   無料枠では、無駄な通信そのものが停止の判定に影響する。
    //   誰もログインしていない夜間・休日に投げ続けない。
    //
    // **失敗の数え上げもしない。**
    //   投げていないものを失敗として数えると、誰かが最初にログインした瞬間に
    //   切断の条件（連続10回）を満たしてしまう
    return;
  }

  try {
    const res = await fetch(API + "/api/ws-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tenko-internal": INTERNAL_TOKEN },
      body: JSON.stringify({ sessionIds: [...bySession.keys()] }),
    });
    if (!res.ok) throw new Error("status " + res.status);
    const d = await res.json();
    const invalid = Array.isArray(d.invalid) ? d.invalid.map(String) : [];

    verifyFails = 0;
    if (verifyBlocked) {
      verifyBlocked = false;
      console.log("[verify] 確認が成功した。認証済みの接続を再び受け付ける");
    }

    let cut = 0;
    for (const sid of invalid) {
      for (const c of bySession.get(sid) ?? []) {
        presence.delete(c);
        c.authed = false;
        try {
          c.send(JSON.stringify({ type: "auth.expired", reason: "session revoked" }));
          c.close(4001, "session revoked");
        } catch { /* 既に閉じている */ }
        cut++;
      }
    }
    if (cut > 0) {
      console.log("[verify] 無効になったセッションの接続を " + cut + " 本切った");
      sendList(true);
    }
  } catch (e) {
    verifyFails++;
    const msg = "[verify] 確認できなかった（" + verifyFails + "回目）: " + e.message;
    if (verifyFails >= VERIFY_FAIL_CUT) {
      // **10回（約10分）続いたら、認証済みの接続を全て切る。**
      // 60秒の遅延を許容できるとした根拠は「短時間の障害なら在席の表示が古くなるだけ」だった。
      // 10分続く障害は、その前提が崩れている
      verifyBlocked = true;
      const n = cutAllAuthed("verify unavailable");
      console.error(msg + " → 連続" + VERIFY_FAIL_CUT + "回。認証済みの接続 " + n + " 本を切り、以後は見るだけ扱いにする");
    } else if (verifyFails >= VERIFY_FAIL_WARN) {
      console.error(msg + " → 連続" + VERIFY_FAIL_WARN + "回以上。新しい接続は受け続ける");
    } else {
      console.log(msg);
    }
  }
}

loadRooms();
loadDemo();
setInterval(() => { loadRooms(); loadDemo(); }, 60_000);
// 無効化の確認は別の周期で回す。取得の失敗が互いに影響しないようにするため
setInterval(verifySessions, VERIFY_INTERVAL_MS);

function capacityOf(roomId) {
  const r = rooms.find((x) => Number(x.id) === Number(roomId));
  return r && Number.isFinite(Number(r.capacity)) ? Number(r.capacity) : 0;
}
// その部屋にいる人数。同じ利用者の複数接続は1人として数える。
// デモ用の利用者も数える。数えないと、村の見た目（建物の下の帯）と定員の判定が食い違う
function occupantsOf(roomId, exceptUserId) {
  const ids = new Set();
  for (const p of presence.values()) {
    if (Number(p.roomId) === Number(roomId) && p.id !== exceptUserId) ids.add(p.id);
  }
  for (const d of demo) {
    if (Number(d.roomId) === Number(roomId) && d.id !== exceptUserId) ids.add(d.id);
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
  // デモ用の利用者を先に入れる。同じIDで実際の接続があれば、そちらで上書きされる
  // （実在の人が優先。デモ用と実在の人が同じIDになることは無いが、念のため）
  for (const d of demo) {
    if (byUser.has(d.id)) continue;
    out.push({
      id: d.id, colorIndex: d.colorIndex, state: d.state, roomId: d.roomId,
      talk: d.talk, x: d.x, y: d.y, connections: 0,
      // 画面が「この人はデモ用」と分かるようにする。
      // 呼びかけ・チャットの案内を変えるために使う（返事が来ないのを不具合に見せない）
      demo: true,
    });
  }
  for (const p of byUser.values()) {
    let connections = 0;
    for (const q of presence.values()) if (q.id === p.id) connections++;
    // 名前は配らない。
    //   - 画面はDBの表示名を使うため、そもそも要らない（J239 / 呼びかけの直しと同じ考え方）
    //   - 配らなければ、自己申告の名前が他人の画面に出る経路が構造的に無くなる
    //   - 50人が同時に動くと1回8KBを毎秒9回配っていた。名前を外すと軽くなる
    out.push({
      id: p.id, colorIndex: p.colorIndex,
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

// 村に入るときの立ち位置。空いているところを探す。
//   - 同じ場所に重ねない（下になった人はクリックで選べなくなる。実機で確認）
//   - 建物の中には置かない（勝手に会議中になり、定員も埋めてしまう）
function freeSpot() {
  for (let i = 0; i < geo.SPOTS.length; i++) {
    const s = geo.defaultSpot(i);
    if (geo.buildingAt(rooms, s.x, s.y)) continue;
    if (geo.onFountain(s.x, s.y)) continue;
    let taken = false;
    // デモ用の利用者の上にも置かない。重なると、下になった人を選べなくなる
    for (const p of [...presence.values(), ...demo]) {
      if (Math.abs(p.x - s.x) < geo.PERSON_SIZE && Math.abs(p.y - s.y) < geo.PERSON_SIZE) { taken = true; break; }
    }
    if (!taken) return s;
  }
  return geo.defaultSpot(presence.size);
}

// 置いた場所に他の人がいたら、近いところへ少しずらす。
// 同じ建物に入ろうとしている場合もあるので、建物の判定より前には動かさない
function nudge(self, at) {
  const overlaps = (x, y) => {
    // 噴水の上には立てない。乗るとお知らせが押せなくなる
    if (geo.onFountain(x, y)) return true;
    for (const q of [...presence.values(), ...demo]) {
      if (q.id === self.id) continue;
      if (Math.abs(q.x - x) < geo.PERSON_SIZE * 0.7 && Math.abs(q.y - y) < geo.PERSON_SIZE * 0.7) return true;
    }
    return false;
  };
  if (!overlaps(at.x, at.y)) return at;
  // 近い順に、8方向へ広げながら空きを探す
  for (let r = 1; r <= 5; r++) {
    const step = Math.round(geo.PERSON_SIZE * 0.75) * r;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const c = geo.clamp(at.x + dx * step, at.y + dy * step);
      if (!overlaps(c.x, c.y)) return c;
    }
  }
  return at;   // 見つからなければ、そのまま置く（動かせない方が困る）
}

// 一度いた場所を覚えておく。
// 画面を読み直すたびに立ち位置が変わると、隣にいた人と離れてしまう（審査役D）。
// サーバーが落ちれば消えてよい情報なので、DBには入れない
const lastSpot = new Map();   // 利用者ID -> { x, y }

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

  // handleProtocols が覚えた判定を受け取る。
  // **既定は「券なし」。** 画面が protocols を1つも送らないと handleProtocols は
  // 呼ばれず、控えに何も入らない。その場合も見るだけとして扱う（実測で確認した）
  const auth = pendingAuth.get(req) ?? { authed: false, why: "券なし（見るだけ）", hadTicket: false };
  pendingAuth.delete(req);
  // 無効化の確認が続けて失敗している間は、券が正しくても認証済みにしない。
  // 無効化されたセッションを見分けられない状態で、村に人を増やさないため
  if (auth.authed && verifyBlocked) {
    auth.authed = false;
    auth.why = "無効化の確認ができないため見るだけ扱い";
    auth.hadTicket = false;   // 券のせいではないので 4003 では切らない
  }
  ws.authed = auth.authed === true;
  ws.userId = ws.authed ? auth.userId : null;
  ws.sessionId = ws.authed ? auth.sessionId : null;

  console.log("[open] " + (ws.isNotifier ? "notifier" : "viewer")
    + " " + (ws.authed ? "認証済み userId=" + ws.userId : "見るだけ（" + auth.why + "）")
    + " clients=" + wss.clients.size);

  // 券があったのに通らなかった接続は、ここで断る。
  // **ハンドシェイクでは断らない**（close code が画面に届かず 1006 になるため）
  if (!ws.isNotifier && auth.hadTicket && !ws.authed) {
    ws.send(JSON.stringify({ type: "auth.rejected", reason: auth.why }));
    ws.close(4003, "ticket invalid");
    return;
  }
  // 見るだけモードを止めているときは、券の無い接続を受けない
  if (!ws.isNotifier && !ws.authed && !PUBLIC_VIEW) {
    ws.close(4004, "public view disabled");
    return;
  }

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
    // **他のどの判定よりも先に、認証を見る。**
    // 券の無い接続（見るだけ）からのメッセージは、種別を問わず全て捨てる
    if (!ws.authed) {
      console.log("[drop] 券の無い接続からの受信を捨てた: " + text.slice(0, 80));
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
      // **利用者IDは券から取る。msg.user.id は読まない**（Phase 5 段階6。S6 を塞ぐ）。
      // ここが段階5まで `Number(u.id)` になっており、他人の在席を偽装できた
      const uid = ws.userId;
      // 同じ人が戻ってきたら、前にいた場所に戻す。初めてなら空いている場所を探す
      const remembered = lastSpot.get(uid);
      let spot = prev ? { x: prev.x, y: prev.y } : (remembered || freeSpot());
      // 覚えていた場所が建物の中なら、定員を見てから戻す。
      // 見ずに戻すと、席が埋まっている部屋へ読み直しだけで入れてしまう
      let roomId = prev ? prev.roomId : null;
      if (!prev) {
        const b = geo.buildingAt(rooms, spot.x, spot.y);
        if (b) {
          const rid = Number(b.room.id);
          if (occupantsOf(rid, uid) < capacityOf(rid)) roomId = rid;
          else spot = freeSpot();   // 満員になっていたら広場に出す
        }
      }
      presence.set(ws, {
        id: uid,
        // 名前も他人の画面に出るため、長さを切る。中継しかしないサーバー側でも防ぐ。
        // （そもそも presenceList では配らない。画面はDBの表示名を使う）
        name: String(u.name || "名無し").slice(0, 40),
        // 色も自己申告を読まない。利用者IDから決める（page.tsx と同じ規則）。
        // 申告を読むと、他人と同じ色を名乗って紛らわしくできる
        colorIndex: ((uid - 1) % 4) + 1,
        // 建物の中にいるなら会議中。位置が状態を決める（Phase 4.8）
        state: roomId != null ? "talking" : state,
        // 建物から出たときに戻す状態。会議中は「位置が決めた状態」なので控えに入れない
        baseState: state === "talking" ? (prev?.baseState ?? "idle") : state,
        roomId,
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
      // 離した瞬間だけ、人が重ならないように少しずらす。
      // 掴んでいる間もずらすと、指の位置と絵が食い違って動かしにくい。
      // 重なったままにすると、下になった人はクリックで選べなくなる
      const at2 = msg.final === true ? nudge(p, at) : at;
      p.x = at2.x;
      p.y = at2.y;
      p.updatedAt = Date.now();
      lastSpot.set(p.id, { x: at2.x, y: at2.y });
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
      // デモ用の利用者には呼びかけられない。
      // 「返事が来ない」ではなく「返事をしない人である」と伝える。
      // 黙って何も起きないと、呼びかけの機能が壊れているように見える（Phase 5 段階5）
      if (demo.some((d) => d.id === to)) {
        ws.send(JSON.stringify({
          type: "call.denied",
          reason: "この人は村の様子を見せるために置いてあるデモの利用者です。返事はしません",
        }));
        return;
      }
      const targets = socketsOf(to);
      if (targets.length === 0) {
        ws.send(JSON.stringify({ type: "call.denied", reason: "相手は村にいません" }));
        return;
      }
      // 送るのは利用者IDだけ。名前は送らない。
      // presence の name は自己申告で騙れるため、画面はDBの表示名で引き直す
      // （Phase 4.6 で村の名前ラベルに対して同じ直しをしている）
      const payload = JSON.stringify({
        type: "call.incoming",
        from: { id: from.id },
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
      // 返事も同じ。名前は送らず、画面がDBの表示名で引き直す
      const payload = JSON.stringify({
        type: "call.answered", from: { id: from.id }, answer,
      });
      for (const t of socketsOf(to)) t.send(payload);
    }
  });

  ws.on("close", () => {
    if (presence.delete(ws)) sendList(true);
    console.log("[close] clients=" + wss.clients.size);
  });
});

// Render では 0.0.0.0 で待ち受ける必要がある（既定でそうなるが、明示しておく）
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("ws-server listening on port " + PORT + " / API=" + API);
  console.log("  見るだけモード: " + (PUBLIC_VIEW ? "有効" : "無効")
    + " / 券の鍵: " + (process.env.TENKO_WS_TICKET_SECRET ? "あり" : "**無し（券が通らない）**")
    + " / 共有秘密: " + (INTERNAL_TOKEN ? "あり" : "**無し（無効化の確認ができない）**"));
});
