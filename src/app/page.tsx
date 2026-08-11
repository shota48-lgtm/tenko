"use client";

// 村の画面（tenko の入口）。
//
// 設計方針（崩さないこと）:
//   - 在席状態・位置・「話しかけてよいか」は WebSocket のみ。DBには保存しない
//   - 「今日やること」は HTTP + DB。他人にも見えるため、入力の検証はサーバー側で行う
//   - 投稿は HTTP。ここでは扱わない（建物を押すとチャットへ移る）
//   - 自動で変えてよいのは「離席」への切り替えだけ。人がいることを機械が主張しない
//
// Phase 4.8 で変わった最大の点（初日の方針をPOの判断で覆した）:
//   - アバターを自分でドラッグして動かせる
//   - **位置が状態を決める。** 建物に入れば会議中、出れば元の状態に戻る
//     → 「会議中」は状態のメニューから外した。選ぶものではなく、結果になった
//   - 移動と定員の判定は ws-server が行う。画面側は結果を描くだけ
//   - 呼びかけ（通話は繋がない）。「話しかけてよいか」と連動させた
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ACTIVE_VARIANT, VARIANTS, sheet } from "@/sprites";
import { BUBBLE } from "@/village/bubbles";
import {
  drawVillage, drawGround, drawNoteMarks, bubbleLayoutFor, hitBuilding, hitPerson,
  buildingRects, clampToVillage, buildingForAvatar, ENTER_MARGIN, hitFountain, fountainRect,
  VILLAGE_W, VILLAGE_H, PERSON_SIZE,
  type Presence, type Room, type NoteMap, type TalkStatus, type RoomCounts, type OccupantsMode,
} from "@/village/render";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";
// 村の拡大率。
//
// 2倍で固定していたところ、村（640x416）が 1280x832 になり、画面に収まらず縦にスクロールした。
// 全員がどこにいるか一目で分かることが村の唯一の価値なので、既定は「全体が入る」にする。
// 整数倍でないと1ドットの大きさが揃わないが、収まらないよりは良い（PHASE49_LOG.md に記載）。
const ZOOM_CLOSE = 2;
const ZOOM_MIN = 1.2;
// 選べる状態。「会議中(talking)」は入っていない。建物に入れば自動でそうなるため（Phase 4.8）
const STATES: Presence["state"][] = ["idle", "away", "resting"];
const STATE_LABEL: Record<Presence["state"], string> = {
  idle: "在席", away: "離席", talking: "会議中", resting: "休憩中",
};
// リングの色。描画側（render.ts）と揃えること
const STATE_DOT: Record<Presence["state"], string> = {
  idle: "bg-[var(--tk-green)]", talking: "bg-[var(--tk-blue)]",
  resting: "bg-[var(--tk-straw)]", away: "bg-stone-400",
};
const TALKS: TalkStatus[] = ["ok", "later", "focus"];
const TALK_LABEL: Record<TalkStatus, string> = {
  ok: "話しかけてOK", later: "後でならOK", focus: "集中中",
};
// 村に出す短いラベル。ok は既定なので出さない（全員に付くと画面が埋まる）
const TALK_TAG: Record<TalkStatus, string | null> = {
  ok: null, later: "後で", focus: "集中中",
};
// 自動離席までの時間。仮説であり、実運用で調整する前提の値
const IDLE_MINUTES = Number(process.env.NEXT_PUBLIC_TENKO_IDLE_MINUTES ?? 10);
const NOTE_MAX = 80;
// 勤怠の下書きの種別。Phase 3 で決めた4つ
const DRAFT_KIND: Record<string, string> = { arrive: "出社", leave: "退勤", break: "休憩", late: "遅刻" };
// 常時出す吹き出しの上限。25人を広場に集めて 3 / 5 / 8 件を実測して決めた。
// 5件以上は吹き出しが横につながって帯に見え、8件では人物の顔にかぶった。
// 3件でも上の段では触れ合うが、読めなくなるところまでは行かない。
// 全員分は「乗せた人の吹き出しは必ず出す」ことと、メンバー一覧で補う（PHASE48_LOG.md に根拠）
const BUBBLE_MAX = 3;
// 移動中に位置を配る間隔。毎フレーム送ると通信量が過大になるため間引く。
// サーバー側でも 50ms にまとめて配っている
const MOVE_INTERVAL_MS = 100;

type User = { id: number; displayName: string };
// 呼びかけ。名前は持たない。表示のたびにDBの表示名で引く（自己申告の名前を画面に出さない）
type Incoming = { id: number; knewFocus?: boolean };

// 認証は未実装。利用者は暫定的に固定値で扱う
function devUser() {
  if (typeof window === "undefined") return { id: 1, name: "利用者1", colorIndex: 1 };
  const q = new URLSearchParams(window.location.search);
  const id = Number(q.get("me") ?? 1);
  return { id, name: q.get("name") ?? "利用者" + id, colorIndex: ((id - 1) % 4) + 1 };
}
function isDebug() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("debug") === "1";
}

const menuBtn = "tk-btn tk-btn-quiet w-full justify-start text-xs";
const menuBtnOn = "tk-btn tk-btn-on w-full justify-start text-xs";

export default function VillagePage() {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [variant, setVariant] = useState<"a" | "b" | "c">(ACTIVE_VARIANT);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [people, setPeople] = useState<Presence[]>([]);
  const [counts, setCounts] = useState<RoomCounts>({});
  const [notes, setNotes] = useState<NoteMap>({});
  const [conn, setConn] = useState<"接続中" | "切断" | "再接続中">("再接続中");
  const [myState, setMyState] = useState<Presence["state"]>("idle");
  const [talk, setTalk] = useState<TalkStatus>("ok");
  const [stale, setStale] = useState(false);
  const [noteInput, setNoteInput] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteSaved, setNoteSaved] = useState(false);
  const [autoAway, setAutoAway] = useState(false);
  const [me, setMe] = useState({ id: 1, name: "利用者1", colorIndex: 1 });
  const [debug, setDebug] = useState(false);
  // アバターを押して出すもの。自分なら操作、他人なら情報だけ
  const [picked, setPicked] = useState<{ id: number; x: number; y: number } | null>(null);
  // 一覧は既定で畳む。村が主役で、一覧は必要なときに開くもの
  const [showRoster, setShowRoster] = useState(false);
  // ドラッグ中の移動先（村の座標）。確定するまで本人の位置は動かさない
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [hoverRoom, setHoverRoom] = useState<number | null>(null);
  const [hoverPerson, setHoverPerson] = useState<number | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  // 断りではない知らせ（部屋に入った・広場に出た）。赤くしない
  const [notice, setNotice] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [callNotice, setCallNotice] = useState<string | null>(null);
  const [answered, setAnswered] = useState<{ id: number; text: string } | null>(null);
  // 集中中の相手に呼びかける前の確認
  const [confirmCall, setConfirmCall] = useState<number | null>(null);
  // 村の拡大率。"fit" は画面に全体が入る大きさ、"close" は2倍（スクロールする）
  const [zoom, setZoom] = useState<"fit" | "close">("fit");
  const [fitScale, setFitScale] = useState(ZOOM_CLOSE);
  // ドラッグ中に、いま入る建物
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  // 装飾を地に馴染ませるか（作業4-3）。?debug=1 で切り替えて見比べられる
  const [quietDeco, setQuietDeco] = useState(true);
  // 部屋ごとの未読件数と、自分の未確定の勤怠の下書き。
  // tenko の主張は「チャットが勤怠になる」なので、村にその両方が出ている必要がある
  const [unread, setUnread] = useState<Record<number, number>>({});
  const [drafts, setDrafts] = useState<{ id: number; kind: string; eventAt: string; matchedText: string }[]>([]);
  const [showDrafts, setShowDrafts] = useState(false);
  // 噴水のお知らせ（機能4-2）。書けるのは admin のみ。判定はAPI側
  type Ann = { id: number; body: string; displayName: string; createdAt: string };
  const [anns, setAnns] = useState<Ann[]>([]);
  const [annUnread, setAnnUnread] = useState(0);
  const [annCanWrite, setAnnCanWrite] = useState(false);
  const [showAnns, setShowAnns] = useState(false);
  const [annInput, setAnnInput] = useState("");
  const [annError, setAnnError] = useState<string | null>(null);
  // 建物の中の人の見せ方。案2（隠して、乗せたときに人数と名前を出す）を採った。
  // 案1（重ねて描く）は、建物が32ドット四方なのに人物が32ドットあり、
  // 定員4でも建物が完全に隠れ、定員12では人物同士も潰れて誰も読めなくなる（実機で確認）。
  // 比較のため ?debug=1 では切り替えられるようにしてある
  const [occupants, setOccupants] = useState<OccupantsMode>("hide");
  const [bubbleMax, setBubbleMax] = useState(BUBBLE_MAX);
  // 吹き出しの見せ方。3案を実機で見比べて決める（作業3-1）
  //   "few"  : 常時3件 + 乗せた人（Phase 4.8 の形）
  //   "all"  : 全員分を出す（重なりは避けるが、避けきれない分は頭上の印だけになる）
  //   "hover": 乗せた人だけ出す
  // 既定は「全員」。22人で重なり0・名前を覆う数0 を実測して決めた（PHASE49_LOG.md）
  const [bubbleMode, setBubbleMode] = useState<"few" | "all" | "hover">("all");
  const [myRole, setMyRole] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const userRef = useRef(me);
  const myStateRef = useRef<Presence["state"]>("idle");
  const talkRef = useRef<TalkStatus>("ok");
  const lastActiveRef = useRef<number>(0);
  // 掴んでいる間の情報。moved は「実際に動かしたか」。
  // 押しただけ（動かさずに離した）ならメニューを出す。これが無いと、
  // 自分のアバターは押しても必ず移動扱いになり、メニューが一生出ない（実機で確認）
  const dragRef = useRef<{ dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const lastSentRef = useRef(0);

  useEffect(() => { myStateRef.current = myState; }, [myState]);
  useEffect(() => { talkRef.current = talk; }, [talk]);
  useEffect(() => { userRef.current = me; }, [me]);

  // 「いま操作した」を記録する。描画中に Date.now() を呼ばないための入れ物
  const touchActivity = useCallback(() => { lastActiveRef.current = Date.now(); }, []);

  const send = useCallback((obj: unknown) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }, []);

  const announce = useCallback((state: Presence["state"], talkStatus: TalkStatus) => {
    return send({ type: "presence.set", user: userRef.current, state, roomId: null, talk: talkStatus });
  }, [send]);

  // 未読と勤怠の下書き。村に出すために定期的に取り直す
  const loadVillage = useCallback(async (uid: number) => {
    try {
      const res = await fetch("/api/village?user=" + uid);
      if (!res.ok) return;
      const d = await res.json();
      setUnread(d.unread ?? {});
      setDrafts(d.drafts ?? []);
    } catch { /* 取れなくても村は描く */ }
  }, []);

  const loadAnns = useCallback(async (uid: number) => {
    try {
      const res = await fetch("/api/announcements?user=" + uid);
      if (!res.ok) return;
      const d = await res.json();
      setAnns(d.announcements ?? []);
      setAnnUnread(Number(d.unread ?? 0));
      setAnnCanWrite(d.canWrite === true);
    } catch { /* 取れなくても村は描く */ }
  }, []);

  const loadNotes = useCallback(async () => {
    try {
      const res = await fetch("/api/notes");
      if (!res.ok) return;
      const d = (await res.json()) as { notes: { user_id: number; body: string }[] };
      const map: NoteMap = {};
      for (const n of d.notes) map[Number(n.user_id)] = n.body;
      setNotes(map);
    } catch { /* 取れなくても村は描く */ }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      // 旧URL（/?room=1 でチャットを開く形）を受けたら、新しいURLへ送る
      const q = new URLSearchParams(window.location.search);
      const legacyRoom = Number(q.get("room"));
      if (Number.isInteger(legacyRoom) && legacyRoom > 0) {
        router.replace("/rooms/" + legacyRoom);
        return;
      }
      const u = devUser();
      setMe(u);
      userRef.current = u;
      setDebug(isDebug());
      void fetch("/api/rooms").then((r) => r.json()).then((d) => setRooms(d.rooms ?? [])).catch(() => {});
      void fetch("/api/users").then((r) => r.json()).then((d) => setUsers(d.users ?? [])).catch(() => {});
      void loadNotes();
      void fetch("/api/notes?user=" + u.id).then((r) => r.json())
        .then((d) => setNoteInput(d.note?.body ?? "")).catch(() => {});
      void fetch("/api/me?user=" + u.id).then((r) => r.json())
        .then((d) => setMyRole(d.me?.role ?? null)).catch(() => {});
      void loadVillage(u.id);
      void loadAnns(u.id);
    }, 0);
    return () => clearTimeout(t);
  }, [loadNotes, loadVillage, loadAnns, router]);

  // WebSocket。在席・位置・呼びかけを配る
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = 1000;

    const connect = () => {
      setConn("再接続中");
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => {
        delay = 1000;
        setConn("接続中");
        setStale(false);
        announce(myStateRef.current, talkRef.current);
        ws.send(JSON.stringify({ type: "presence.sync" }));
      };
      ws.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data as string);
          if (d.type === "presence.list") {
            // 同じ利用者が複数の端末から接続していても、村では1人として扱う
            const byId = new Map<number, Presence>();
            for (const p of (d.users ?? []) as Presence[]) byId.set(Number(p.id), { ...p, id: Number(p.id) });
            setPeople(Array.from(byId.values()));
            if (d.rooms) setCounts(d.rooms as RoomCounts);
          } else if (d.type === "presence.denied") {
            // 満員・不正な座標など。押した本人にだけ返る
            setDenied(String(d.reason ?? "移動できませんでした"));
          } else if (d.type === "call.incoming") {
            // 名前は受け取らない。IDだけを持ち、表示のときにDBの表示名で引く
            setIncoming({ id: Number(d.from?.id), knewFocus: d.knewFocus });
          } else if (d.type === "call.sent") {
            setCallNotice("呼びかけました。相手の返事を待っています");
          } else if (d.type === "call.denied") {
            setCallNotice(String(d.reason ?? "呼びかけられませんでした"));
          } else if (d.type === "call.answered") {
            const a = d.answer === "accept" ? "「いま話せます」と返事がありました"
              : d.answer === "later" ? "「あとで」と返事がありました"
                : "「いまは難しい」と返事がありました";
            // ここも名前はDBの表示名で引く（届いた値をそのまま出さない）
            setAnswered({ id: Number(d.from?.id), text: a });
          }
        } catch { /* 解釈できない通知は捨てる */ }
      };
      ws.onclose = () => {
        if (closed) return;
        setConn("切断");
        setStale(true);
        timer = setTimeout(() => { delay = Math.min(delay * 2, 5000); connect(); }, delay);
      };
      ws.onerror = () => { /* close が続けて呼ばれる */ };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [announce]);

  // 断られた理由・呼びかけの結果は数秒で消す。画面に残し続けると邪魔になる
  useEffect(() => {
    if (!denied) return;
    const t = setTimeout(() => setDenied(null), 4000);
    return () => clearTimeout(t);
  }, [denied]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!callNotice) return;
    const t = setTimeout(() => setCallNotice(null), 5000);
    return () => clearTimeout(t);
  }, [callNotice]);
  useEffect(() => {
    if (!answered) return;
    const t = setTimeout(() => setAnswered(null), 6000);
    return () => clearTimeout(t);
  }, [answered]);

  // 自動離席。away にするだけで、idle へは自動で戻さない
  useEffect(() => {
    lastActiveRef.current = Date.now();
    const touch = () => { lastActiveRef.current = Date.now(); };
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "wheel", "touchstart"];
    for (const ev of events) window.addEventListener(ev, touch, { passive: true });
    const onVisible = () => { if (document.visibilityState === "visible") touch(); };
    document.addEventListener("visibilitychange", onVisible);

    const timer = setInterval(() => {
      if (myStateRef.current === "away") return;
      if (Date.now() - lastActiveRef.current >= IDLE_MINUTES * 60_000) {
        setAutoAway(true);
        setMyState("away");
        announce("away", talkRef.current);
      }
    }, 15_000);

    return () => {
      for (const ev of events) window.removeEventListener(ev, touch);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [announce]);

  useEffect(() => {
    const t = setInterval(() => { void loadNotes(); void loadVillage(userRef.current.id); }, 30_000);
    return () => clearInterval(t);
  }, [loadNotes, loadVillage]);

  // 画面に村全体が入る拡大率を測る。窓の大きさが変わるたびに測り直す
  useEffect(() => {
    const measure = () => {
      // ヘッダ・下部の帯・余白の分を引く。
      // 見積もりが12ドット甘く、2倍でちょうど1ドットはみ出してスクロールしていた（実測）
      const w = window.innerWidth - 40;
      const h = window.innerHeight - 120;
      const s = Math.min(w / VILLAGE_W, h / VILLAGE_H, ZOOM_CLOSE);
      setFitScale(Math.max(ZOOM_MIN, Math.floor(s * 20) / 20));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const SCALE = zoom === "close" ? ZOOM_CLOSE : fitScale;

  // 建物の中の人を隠す案（案2）では、その人の吹き出しも出さない。
  // マウスを乗せている人は先頭に回し、上限に関係なく必ず出す
  // （常時出すのは3件までだが、見たい人のものは必ず読めるようにするため）
  const bubblePeople = useMemo(() => {
    const base = occupants === "hide"
      ? people.filter((p) => p.roomId == null || Number(p.id) === me.id)
      : people;
    if (hoverPerson == null) return base;
    const hit = base.find((p) => Number(p.id) === hoverPerson);
    return hit ? [hit, ...base.filter((p) => p !== hit)] : base;
  }, [people, occupants, hoverPerson, me.id]);
  const layout = useMemo(() => {
    if (bubbleMode === "hover") {
      // 乗せた人だけ。誰も乗せていなければ吹き出しは出ない
      return bubbleLayoutFor(rooms, bubblePeople, notes, 1, hoverPerson == null ? [] : [hoverPerson]);
    }
    const max = bubbleMode === "all" ? bubblePeople.length : bubbleMax;
    // 全員分を出すときは1行に絞る（2行だと高さが倍になり、他人の名前を覆う）
    return bubbleLayoutFor(rooms, bubblePeople, notes, max, undefined, bubbleMode === "all" ? 1 : undefined);
  }, [rooms, bubblePeople, notes, bubbleMax, bubbleMode, hoverPerson]);

  // 地面は変わらないので一度だけ描いて使い回す（毎回描くと約27万回になり固まる）
  const ground = useMemo(() => {
    if (typeof document === "undefined") return null;
    const off = document.createElement("canvas");
    off.width = VILLAGE_W;
    off.height = VILLAGE_H;
    const octx = off.getContext("2d");
    if (!octx) return null;
    drawGround(octx, sheet(variant), quietDeco);
    return off;
  }, [variant, quietDeco]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, VILLAGE_W, VILLAGE_H);
    if (ground) ctx.drawImage(ground, 0, 0);
    drawVillage(ctx, sheet(variant), rooms, people, !ground, counts, occupants, dropTarget, unread, me.id);
    drawNoteMarks(ctx, sheet(variant), layout);
  }, [rooms, people, variant, layout, ground, counts, occupants, dropTarget, unread, me.id]);

  // ---- 移動（作業1）----
  //
  // 動かせるのは自分のアバターだけ。他人を掴んでも何も起きない。
  // 送るのは座標だけで、利用者IDは送らない（サーバーが接続から決めるため、なりすませない）
  const toVillage = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current!;
    const rect = cv.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / SCALE, y: (e.clientY - rect.top) / SCALE };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const at = toVillage(e);
    const person = hitPerson(rooms, people, at.x, at.y);
    if (person && Number(person.id) === me.id) {
      const spot = layout.spots.find((s) => Number(s.p.id) === me.id);
      dragRef.current = {
        dx: at.x - (spot?.x ?? at.x), dy: at.y - (spot?.y ?? at.y),
        sx: at.x, sy: at.y, moved: false,
      };
      try { (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId); } catch { /* 捕まえられなくても動く */ }
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const at = toVillage(e);
    if (dragRef.current) {
      // 手が震えた程度では動かしたことにしない（押しただけの操作を潰さないため）
      if (Math.abs(at.x - dragRef.current.sx) > 2 || Math.abs(at.y - dragRef.current.sy) > 2) {
        dragRef.current.moved = true;
      }
      if (!dragRef.current.moved) return;
      const to = clampToVillage(at.x - dragRef.current.dx, at.y - dragRef.current.dy);
      setDrag(to);
      // いま離したらどの建物に入るかを見せる。
      // 落としてみるまで狙いが合っているか分からない状態を作らない
      const target = buildingForAvatar(rooms, to.x, to.y);
      setDropTarget(target ? target.room.id : null);
      // 間引いて送る。毎フレーム送ると1人あたり毎秒60件になる
      const now = Date.now();
      if (now - lastSentRef.current >= MOVE_INTERVAL_MS) {
        lastSentRef.current = now;
        send({ type: "presence.move", x: to.x, y: to.y });
      }
      return;
    }
    // 掴んでいないときは、乗せているものを拾う（部屋名・定員はここでしか出さない）
    const r = hitBuilding(rooms, at.x, at.y);
    setHoverRoom(r ? r.id : null);
    const p = hitPerson(rooms, people, at.x, at.y);
    setHoverPerson(p ? Number(p.id) : null);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      const moved = dragRef.current.moved;
      if (moved) {
        const at = toVillage(e);
        const to = clampToVillage(at.x - dragRef.current.dx, at.y - dragRef.current.dy);
        // 離した位置は必ず送る（間引きで最後の1件が落ちないように）。
        // final を付けると、サーバーが人の重なりを避けて少しずらす
        send({ type: "presence.move", x: to.x, y: to.y, final: true });
        // 落とした結果を言葉でも出す。黙って広場に置かれると、
        // 建物に入ろうとして外したのか、そもそも入れないのかが分からない
        const target = buildingForAvatar(rooms, to.x, to.y);
        const wasIn = people.find((p) => Number(p.id) === me.id)?.roomId ?? null;
        if (target) {
          const c = counts[target.room.id];
          if (c && c.used >= c.capacity && Number(wasIn) !== target.room.id) {
            setDenied("「" + target.room.name + "」は満員です（" + c.used + "/" + c.capacity + "）");
          } else {
            setNotice("「" + target.room.name + "」に入りました");
          }
        } else if (wasIn != null) {
          setNotice("広場に出ました");
        }
      }
      dragRef.current = null;
      setDrag(null);
      setDropTarget(null);
      touchActivity();
      setAutoAway(false);
      if (moved) return;
      // 動かしていないなら、押しただけとして自分のメニューを出す
      const spot = layout.spots.find((s) => Number(s.p.id) === me.id);
      setPicked({ id: me.id, x: spot?.x ?? 0, y: spot?.y ?? 0 });
      return;
    }
    // 掴んでいなければ、押した扱い
    const at = toVillage(e);
    const person = hitPerson(rooms, people, at.x, at.y);
    if (person) {
      const spot = layout.spots.find((s) => Number(s.p.id) === Number(person.id));
      setPicked({ id: Number(person.id), x: spot?.x ?? at.x, y: spot?.y ?? at.y });
      return;
    }
    setPicked(null);
    // 噴水はお知らせ。村の中心にあり、一番目立つ場所なので、ここに置く
    if (hitFountain(at.x, at.y)) { void openAnns(); return; }
    const room = hitBuilding(rooms, at.x, at.y);
    if (room) router.push("/rooms/" + room.id);
  };

  const changeState = useCallback((s: Presence["state"]) => {
    setAutoAway(false);
    lastActiveRef.current = Date.now();
    setMyState(s);
    announce(s, talkRef.current);
  }, [announce]);

  const changeTalk = useCallback((t: TalkStatus) => {
    setTalk(t);
    announce(myStateRef.current, t);
  }, [announce]);

  // 建物から出る。広場の空いているところへ移す（サーバーが重なりを避けてくれる）
  const leaveBuilding = useCallback(() => {
    const b = buildingRects(rooms).find((r) => r.room.id === Number(
      people.find((p) => Number(p.id) === me.id)?.roomId,
    ));
    if (!b) return;
    const to = clampToVillage(b.x, b.y + PERSON_SIZE + ENTER_MARGIN + 6);
    send({ type: "presence.move", x: to.x, y: to.y, final: true });
    setPicked(null);
    setNotice("広場に出ました");
  }, [rooms, people, me.id, send]);

  const leaveVillage = useCallback(() => {
    send({ type: "presence.set", user: userRef.current, state: "off" });
    setPicked(null);
  }, [send]);

  const saveNote = async () => {
    setNoteError(null);
    setNoteSaved(false);
    const res = await fetch("/api/notes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: noteInput, user: me.id }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setNoteError(j.error ?? "保存できませんでした");
      return;
    }
    const j = await res.json();
    setNoteInput(j.note.body);
    setNoteSaved(true);
    await loadNotes();
  };

  const clearNote = async () => {
    await fetch("/api/notes", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: me.id }),
    });
    setNoteInput("");
    setNoteSaved(false);
    await loadNotes();
  };

  // 全員の一覧。村にいない人（退勤・未接続）も出す
  const roster = useMemo(() => {
    const byId = new Map<number, Presence>();
    for (const p of people) byId.set(Number(p.id), p);
    const order: Record<string, number> = { talking: 0, idle: 1, resting: 2, away: 3, off: 4 };
    return users
      .map((u) => {
        const p = byId.get(u.id);
        return {
          id: u.id,
          // 名前は DB の表示名を正とする。presence の name は自己申告で騙れる
          name: u.displayName,
          state: (p?.state ?? "off") as Presence["state"] | "off",
          talk: p?.talk,
          note: notes[u.id] ?? "",
        };
      })
      .sort((a, b) => (order[a.state] - order[b.state]) || a.id - b.id);
  }, [users, people, notes]);

  const nameOf = useCallback(
    (id: number) => users.find((u) => u.id === id)?.displayName ?? "利用者" + id,
    [users],
  );

  // 村に置く名前と話しかけ可否のラベル。人物の座標に合わせて重ねる
  const tags = useMemo(() => {
    // 自分は建物の中にいても名前を出す。掴む手がかりになるため
    const shown = occupants === "hide"
      ? layout.spots.filter((s) => s.p.roomId == null || Number(s.p.id) === me.id)
      : layout.spots;
    return shown.map((s) => ({
      id: Number(s.p.id),
      x: s.x,
      y: s.y,
      name: nameOf(Number(s.p.id)),
      talk: (s.p.talk ?? "ok") as TalkStatus,
      state: s.p.state,
      isMe: Number(s.p.id) === me.id,
    }));
  }, [layout.spots, nameOf, me.id, occupants]);

  // 自分の立ち位置。頭上に出すもの（勤怠の印）の座標に使う
  const myTag = tags.find((t) => t.isMe) ?? null;
  // 村にいる人数。「メンバー」を押す動機を出すために添える
  const inVillage = roster.filter((r) => r.state !== "off").length;

  // 噴水を押したとき。開いた時点で既読にする
  const openAnns = async () => {
    setShowAnns(true);
    await fetch("/api/announcements", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: me.id }),
    }).catch(() => {});
    await loadAnns(me.id);
  };

  const postAnn = async () => {
    setAnnError(null);
    const res = await fetch("/api/announcements", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: annInput, user: me.id }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setAnnError(j.error ?? "書けませんでした");
      return;
    }
    setAnnInput("");
    await loadAnns(me.id);
  };

  const decideDraft = async (id: number, action: "confirm" | "reject") => {
    await fetch("/api/attendance/drafts/" + id, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, user: me.id }),
    });
    await loadVillage(me.id);
  };

  const pickedPerson = picked ? people.find((p) => Number(p.id) === picked.id) : undefined;
  const pickedIsMe = picked?.id === me.id;
  // 承認への導線を出すかどうか。役割はサーバーが決める（画面の見せ方だけの話であり、
  // 承認そのものの権限は API 側で毎回DBから引き直して判定している）
  const canApprove = myRole === "manager" || myRole === "admin";
  const roomRect = useMemo(
    () => buildingRects(rooms).find((r) => r.room.id === hoverRoom) ?? null,
    [rooms, hoverRoom],
  );
  // 建物の中にいる人（案2で建物を押したときに見せる）
  const occupantsOf = useCallback(
    (roomId: number) => people.filter((p) => Number(p.roomId) === roomId).map((p) => nameOf(Number(p.id))),
    [people, nameOf],
  );

  // 呼びかけ。
  //
  // 「集中中」の人へは、呼びかけを止めるのではなく確認を挟む形にした。
  // 止めてしまうと、急ぎの用事のときに別の連絡手段へ逃げることになり、
  // 「集中中」を出すこと自体が避けられるようになる。
  // 相手には「集中中と分かったうえで呼びかけている」ことが伝わり、断りやすくしてある。
  //
  // 確認はブラウザの confirm を使わない。画面が止まるうえ、村の見た目から浮くため
  const callTo = (id: number, forced = false) => {
    const target = people.find((p) => Number(p.id) === id);
    const focus = (target?.talk ?? "ok") === "focus";
    if (focus && !forced) { setConfirmCall(id); return; }
    send({ type: "call.invite", to: id, knewFocus: focus });
    setConfirmCall(null);
    setPicked(null);
  };

  return (
    <main className="min-h-screen" style={{ background: "var(--tk-paper)" }}>
      {/* ヘッダはアプリ名だけ。正常な接続は既定なので出さない（切断のときだけ赤く出す） */}
      <header className="tk-head flex items-center gap-3 px-4 py-1.5">
        <h1 className="text-sm font-bold tracking-widest">tenko</h1>
        {conn !== "接続中" && (
          <span
            className="border border-[var(--tk-ink)] px-2 py-0.5 text-[11px] font-bold text-white"
            style={{ background: "var(--tk-red)" }}
            role="status"
          >
            {conn === "切断" ? "切断されました" : "つなぎ直しています"}
            {stale && "（表示は切断前のものです）"}
          </span>
        )}
        {/* 認証が無いことを利用者にも見える形で出す（6-3）。
            目立ちすぎず、しかし気づける位置に置く。README にも記載 */}
        <span
          className="border border-[var(--tk-ink)] px-1.5 py-0.5 text-[10px]"
          style={{ background: "var(--tk-straw)", color: "var(--tk-ink)" }}
          title="URLの me= を変えると誰にでもなりすませます。本番では使えません"
        >
          お試し版・ログインなし（誰にでもなりすませます）
        </span>
        {debug && (
          <span className="ml-auto flex items-center gap-2 text-[11px]">
            <button onClick={() => setOccupants((v) => (v === "show" ? "hide" : "show"))} className="tk-btn tk-btn-quiet px-1.5 py-0.5">
              建物の中: {occupants === "show" ? "案1 重ねて描く" : "案2 隠す"}
            </button>
            <button
              onClick={() => setBubbleMode((m) => (m === "few" ? "all" : m === "all" ? "hover" : "few"))}
              className="tk-btn tk-btn-quiet px-1.5 py-0.5"
            >
              吹き出し: {bubbleMode === "few" ? "案1 常時" + bubbleMax + "件" : bubbleMode === "all" ? "案2 全員" : "案3 乗せた人だけ"}
            </button>
            <button onClick={() => setQuietDeco((v) => !v)} className="tk-btn tk-btn-quiet px-1.5 py-0.5">
              装飾: {quietDeco ? "馴染ませる" : "そのまま"}
            </button>
            {(["a", "b", "c"] as const).map((k) => (
              <button key={k} onClick={() => setVariant(k)} disabled={k === variant} className={"tk-btn px-1.5 py-0.5 " + (k === variant ? "tk-btn-on" : "tk-btn-quiet")}>
                {k.toUpperCase()} {VARIANTS[k].meta.name}
              </button>
            ))}
          </span>
        )}
      </header>

      {/* 一覧を畳んでいるときは村を中央に置く。左に寄せると右が大きく空く（審査役B）*/}
      <div className={"flex items-start gap-3 p-3 " + (showRoster ? "" : "justify-center")}>
        {/* 全体を見るときはスクロールさせない。一覧性が村の価値なので、
            スクロールが出た時点で「全員がどこにいるか」が一目で分からなくなる */}
        <div className={"tk-panel bg-black " + (zoom === "close" ? "max-h-[calc(100vh-7rem)] overflow-auto" : "")}>
          <div className="relative" style={{ width: VILLAGE_W * SCALE, height: VILLAGE_H * SCALE }}>
            <canvas
              ref={canvasRef}
              width={VILLAGE_W}
              height={VILLAGE_H}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => { setHoverRoom(null); setHoverPerson(null); }}
              className={"block touch-none " + (drag ? "cursor-grabbing" : "cursor-pointer")}
              style={{ width: VILLAGE_W * SCALE, height: VILLAGE_H * SCALE, imageRendering: "pixelated" }}
            />

            {/* ドラッグ中の移動先。掴んでいる間だけ出す */}
            {drag && (
              <div
                className="pointer-events-none absolute border-2 border-dashed"
                style={{
                  left: drag.x * SCALE, top: drag.y * SCALE,
                  width: PERSON_SIZE * SCALE, height: PERSON_SIZE * SCALE,
                  borderColor: "var(--tk-straw)", background: "rgba(242,212,137,0.25)",
                }}
              />
            )}

            {/* 名前と話しかけ可否。アバターのすぐ下に置く */}
            {tags.map((t) => (
              <div
                key={t.id}
                className="pointer-events-none absolute flex items-center gap-0.5 whitespace-nowrap"
                style={{
                  // 村の端でラベルが切れないよう、左右を村の中に収める
                  left: Math.min(Math.max((t.x + PERSON_SIZE / 2) * SCALE, 34), VILLAGE_W * SCALE - 34),
                  // 足元のリングを隠さない位置に置く
                  top: (t.y + PERSON_SIZE + 5) * SCALE,
                  transform: "translateX(-50%)",
                  opacity: drag && t.isMe ? 0.35 : 1,
                }}
              >
                {TALK_TAG[t.talk] && (
                  <span
                    className="px-1 text-[9px] leading-[13px] text-white"
                    // 色は状態（足元のリング）だけに使う。
                    // 話しかけ可否まで色で示すと、どちらが主の情報か分からなくなる（作業3-3）
                    style={{ background: "var(--tk-ink)", color: "var(--tk-paper)" }}
                  >
                    {TALK_TAG[t.talk]}
                  </span>
                )}
                {/* 自分だけは「あなた」と出す。
                    説明文を消したので、どれが自分か分からないと掴むこともできない（審査役B）*/}
                {t.isMe && (
                  <span className="px-1 text-[9px] leading-[13px] font-bold" style={{ background: "var(--tk-straw)", color: "var(--tk-ink)" }}>
                    あなた
                  </span>
                )}
                <span
                  className="px-1 text-[10px] leading-[12px]"
                  style={{ background: t.isMe ? "var(--tk-ink)" : "rgba(51,48,42,0.8)", color: t.isMe ? "#f2d489" : "#fff" }}
                >
                  {t.name}
                </span>
              </div>
            ))}

            {/* 今日やること */}
            {layout.boxes.map((b) => {
              return (
                <div
                  key={b.userId}
                  className="pointer-events-none absolute overflow-hidden border border-[var(--tk-ink)]"
                  style={{
                    // 配置の計算が決めた位置に置く。
                    // しっぽの位置に描いていたため、重なりを避けた結果が捨てられていた（実測で判明）
                    left: b.x * SCALE,
                    top: b.y * SCALE,
                    // 配置の計算（bubbles.ts）が出した大きさで描く。
                    // CSS に大きさを任せていたところ、計算上は重なっていない吹き出しが
                    // 実際には他人の名前を覆っていた（19件中17件。実測）
                    width: b.w * SCALE,
                    height: b.h * SCALE,
                    padding: `${BUBBLE.padY * SCALE}px ${BUBBLE.padX * SCALE}px`,
                    fontSize: BUBBLE.charW * SCALE * 0.95,
                    lineHeight: `${BUBBLE.lineHeight * SCALE}px`,
                    whiteSpace: "pre-wrap", wordBreak: "break-all",
                    background: "var(--tk-paper)", color: "var(--tk-ink)",
                  }}
                >
                  {b.lines.join("\n")}
                </div>
              );
            })}

            {/* 建物に乗せたときだけ出す名前と定員。常時出すと村が文字だらけになる */}
            {roomRect && !drag && (
              <div
                className="pointer-events-none absolute z-10 whitespace-nowrap border border-[var(--tk-ink)] px-1.5 py-0.5 text-[11px]"
                style={{
                  left: (roomRect.x + roomRect.w / 2) * SCALE,
                  top: roomRect.y * SCALE - 4,
                  transform: "translate(-50%, -100%)",
                  background: "var(--tk-paper)",
                }}
              >
                <b>{roomRect.room.name}</b>
                <span className="ml-1.5" style={{
                  color: (counts[roomRect.room.id]?.used ?? 0) >= (counts[roomRect.room.id]?.capacity ?? 0)
                    ? "var(--tk-red)" : "var(--tk-ink-soft)",
                }}>
                  {counts[roomRect.room.id]?.used ?? 0}/{counts[roomRect.room.id]?.capacity ?? roomRect.room.capacity ?? "-"}
                  {(counts[roomRect.room.id]?.used ?? 0) >= (counts[roomRect.room.id]?.capacity ?? 99) && " 満員"}
                </span>
                {occupants === "hide" && occupantsOf(roomRect.room.id).length > 0 && (
                  <div className="mt-0.5 text-[10px]">{occupantsOf(roomRect.room.id).join("、")}</div>
                )}
              </div>
            )}

            {/* 掴めることに気づけるように、自分に乗せたときだけ出す */}
            {hoverPerson === me.id && !drag && !picked && (
              <div
                className="pointer-events-none absolute z-10 whitespace-nowrap border border-[var(--tk-ink)] px-1.5 py-0.5 text-[11px]"
                style={{
                  left: Math.min((layout.spots.find((s) => Number(s.p.id) === me.id)?.x ?? 0) * SCALE, VILLAGE_W * SCALE - 150),
                  top: ((layout.spots.find((s) => Number(s.p.id) === me.id)?.y ?? 0) - 12) * SCALE,
                  background: "var(--tk-straw)",
                }}
              >
                ドラッグで移動 / 押すとメニュー
              </div>
            )}

            {/* 噴水のお知らせ。未読があれば赤く、無ければ控えめに、常時出す。
                札を常時出すのは、噴水が押せることに気づけるようにするため */}
            <button
              onClick={openAnns}
              className="absolute z-10 border border-[var(--tk-ink)] px-1 text-[10px] font-bold"
              style={{
                left: (fountainRect.x + fountainRect.w / 2) * SCALE,
                top: (fountainRect.y - 14) * SCALE,
                transform: "translateX(-50%)",
                background: annUnread > 0 ? "var(--tk-red)" : "var(--tk-paper)",
                color: annUnread > 0 ? "#fff" : "var(--tk-ink)",
              }}
              title="村のお知らせ"
            >
              お知らせ{annUnread > 0 ? " " + annUnread : ""}
            </button>

            {/* 勤怠の下書きの印。自分のアバターの頭の上に出す。
                tenko の主張は「チャットが勤怠になる」なので、村を見ただけで
                「確定していない勤怠がある」ことが分かる必要がある */}
            {drafts.length > 0 && myTag && (
              <button
                onClick={() => setShowDrafts((v) => !v)}
                className="absolute z-10 border border-[var(--tk-ink)] px-1 text-[10px] font-bold"
                style={{
                  left: (myTag.x + PERSON_SIZE / 2) * SCALE,
                  top: (myTag.y - 14) * SCALE,
                  transform: "translateX(-50%)",
                  background: "var(--tk-straw)", color: "var(--tk-ink)",
                }}
                title="確定していない勤怠の下書き"
              >
                勤怠 {drafts.length}
              </button>
            )}

            {showDrafts && drafts.length > 0 && (
              <div
                className="tk-panel absolute z-20 w-64 p-2"
                style={{
                  left: Math.min((myTag?.x ?? 0) * SCALE, VILLAGE_W * SCALE - 270),
                  top: Math.max(((myTag?.y ?? 0) - 16) * SCALE - 8, 4),
                  transform: (myTag?.y ?? 0) > VILLAGE_H / 2 ? "translateY(-100%)" : "translateY(0)",
                }}
              >
                <div className="tk-sep mb-1 flex items-center pb-1">
                  <span className="text-xs font-bold">確定していない勤怠</span>
                  <button onClick={() => setShowDrafts(false)} className="tk-btn tk-btn-quiet ml-auto px-1 py-0 text-[10px]">×</button>
                </div>
                <p className="mb-1 text-[10px]" style={{ color: "var(--tk-ink-soft)" }}>
                  発言から立てた下書きです。押すまで勤怠には記録されません
                </p>
                <ul className="space-y-1">
                  {drafts.map((d) => (
                    <li key={d.id} className="tk-sep pb-1">
                      <div className="flex items-center gap-1.5">
                        <span className="px-1 text-[10px] text-white" style={{ background: "var(--tk-wood)" }}>
                          {DRAFT_KIND[d.kind] ?? d.kind}
                        </span>
                        <span className="text-xs tabular-nums">
                          {new Date(d.eventAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <span className="ml-auto flex gap-1">
                          <button onClick={() => decideDraft(d.id, "confirm")} className="tk-btn px-1.5 py-0 text-[11px]">確定</button>
                          <button onClick={() => decideDraft(d.id, "reject")} className="tk-btn tk-btn-quiet px-1.5 py-0 text-[11px]">却下</button>
                        </span>
                      </div>
                      <p className="text-[10px]" style={{ color: "var(--tk-ink-soft)" }}>一致: {d.matchedText}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 落とした結果の知らせ。断りではないので赤くしない */}
            {notice && !denied && (
              <div
                className="absolute inset-x-0 top-2 z-20 mx-auto w-fit border border-[var(--tk-ink)] px-3 py-1 text-xs"
                style={{ background: "var(--tk-paper)" }}
                role="status"
              >
                {notice}
              </div>
            )}

            {/* 断られた理由（満員など）。押した本人にだけ出す */}
            {denied && (
              <div
                className="absolute inset-x-0 top-2 z-20 mx-auto w-fit border border-[var(--tk-ink)] px-3 py-1 text-xs font-bold text-white"
                style={{ background: "var(--tk-red)" }}
                role="alert"
              >
                {denied}
              </div>
            )}

            {/* アバターを押して出すもの。自分なら操作、他人なら見るだけ */}
            {picked && (
              <div
                className="tk-panel absolute z-10 w-56 p-2"
                style={{
                  left: Math.min(picked.x * SCALE, VILLAGE_W * SCALE - 240),
                  // 村の下半分にいる人は、メニューを上向きに出す
                  top: picked.y * SCALE,
                  transform: picked.y > VILLAGE_H / 2 ? "translateY(-100%)" : `translateY(${PERSON_SIZE * SCALE}px)`,
                }}
              >
                <div className="tk-sep mb-1.5 flex items-center gap-1.5 pb-1">
                  <span className={"h-2 w-2 " + (pickedPerson ? STATE_DOT[pickedPerson.state] : "bg-stone-300")} />
                  <span className="text-xs font-bold">{nameOf(picked.id)}</span>
                  <span className="ml-auto text-[10px]" style={{ color: "var(--tk-ink-soft)" }}>
                    {pickedPerson ? STATE_LABEL[pickedPerson.state] : "村にいない"}
                  </span>
                  <button onClick={() => setPicked(null)} className="tk-btn tk-btn-quiet px-1 py-0 text-[10px]" aria-label="閉じる">×</button>
                </div>

                {pickedIsMe ? (
                  <div className="space-y-1.5">
                    <div>
                      <p className="mb-0.5 text-[10px]" style={{ color: "var(--tk-ink-soft)" }}>自分の状態</p>
                      <div className="grid grid-cols-3 gap-1">
                        {STATES.map((s) => (
                          <button key={s} onClick={() => changeState(s)} className={(s === myState ? menuBtnOn : menuBtn) + " justify-center px-1"}>
                            {STATE_LABEL[s]}
                          </button>
                        ))}
                      </div>
                      {pickedPerson?.roomId != null && (
                        <>
                          <p className="mt-0.5 text-[10px]" style={{ color: "var(--tk-ink-soft)" }}>
                            いまは建物の中なので会議中です
                          </p>
                          {/* ドラッグで出るのが基本だが、押して出る道も残す */}
                          <button onClick={leaveBuilding} className={menuBtn + " mt-1 justify-center"}>
                            建物から出る
                          </button>
                        </>
                      )}
                    </div>
                    <div>
                      <p className="mb-0.5 text-[10px]" style={{ color: "var(--tk-ink-soft)" }}>話しかけて</p>
                      <div className="space-y-1">
                        {TALKS.map((t) => (
                          <button key={t} onClick={() => changeTalk(t)} className={t === talk ? menuBtnOn : menuBtn}>
                            {TALK_LABEL[t]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="mb-0.5 text-[10px]" style={{ color: "var(--tk-ink-soft)" }}>
                        今日やること
                        <span className={"ml-1 " + (Array.from(noteInput).length > NOTE_MAX ? "font-bold text-[var(--tk-red)]" : "")}>
                          {Array.from(noteInput).length}/{NOTE_MAX}
                        </span>
                      </p>
                      <input
                        value={noteInput}
                        onChange={(e) => { setNoteInput(e.target.value); setNoteSaved(false); }}
                        onKeyDown={(e) => { if (e.key === "Enter") void saveNote(); }}
                        maxLength={200}
                        placeholder="例: 見積もりの作成"
                        className="tk-input w-full text-xs"
                      />
                      <div className="mt-1 flex gap-1">
                        <button onClick={saveNote} className="tk-btn flex-1 justify-center text-xs">保存</button>
                        <button onClick={clearNote} className={menuBtn + " flex-1 justify-center"}>消す</button>
                      </div>
                      {noteError && <p className="mt-1 text-[10px] font-bold" style={{ color: "var(--tk-red)" }}>{noteError}</p>}
                      {noteSaved && !noteError && <p className="mt-1 text-[10px]" style={{ color: "var(--tk-green)" }}>保存しました</p>}
                    </div>
                    {/* 村から勤怠・承認へ行けるようにする（作業6）*/}
                    <div className="tk-sep pt-1" />
                    <div className="space-y-1">
                      <Link href="/attendance" className={menuBtn}>勤怠の確認・修正申請</Link>
                      {canApprove && <Link href="/approvals" className={menuBtn}>承認する</Link>}
                      <button onClick={leaveVillage} className={menuBtn}>退勤（村から消える）</button>
                    </div>
                    <p className="text-[10px]" style={{ color: "var(--tk-ink-soft)" }}>
                      表示名は管理者が決めます（この画面では変えられません）
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1 text-xs">
                    <p>話しかけて: {pickedPerson ? TALK_LABEL[(pickedPerson.talk ?? "ok") as TalkStatus] : "-"}</p>
                    <p>
                      今日やること: {notes[picked.id] ? notes[picked.id] : <span style={{ color: "var(--tk-ink-soft)" }}>未記入</span>}
                    </p>
                    {pickedPerson && confirmCall !== picked.id && (
                      <button onClick={() => callTo(picked.id)} className="tk-btn w-full justify-center text-xs">
                        呼びかける
                        {(pickedPerson.talk ?? "ok") === "later" && "（後でならOK）"}
                        {(pickedPerson.talk ?? "ok") === "focus" && "（集中中）"}
                      </button>
                    )}
                    {pickedPerson && confirmCall === picked.id && (
                      <div className="border border-[var(--tk-ink)] p-1.5" style={{ background: "var(--tk-straw)" }}>
                        <p className="text-[11px] leading-4">
                          集中中です。急ぎでなければ、あとにしてください。<br />
                          呼びかけると、集中中と分かったうえで呼んだことが相手に伝わります。
                        </p>
                        <div className="mt-1.5 flex gap-1">
                          <button onClick={() => callTo(picked.id, true)} className="tk-btn flex-1 justify-center text-xs">
                            それでも呼びかける
                          </button>
                          <button onClick={() => setConfirmCall(null)} className="tk-btn tk-btn-quiet flex-1 justify-center text-xs">
                            やめる
                          </button>
                        </div>
                      </div>
                    )}
                    <p className="text-[10px]" style={{ color: "var(--tk-ink-soft)" }}>他の人の状態は変えられません。</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {showRoster && (
          <aside className="tk-panel w-72 shrink-0">
            <div className="tk-head px-3 py-2">
              <h2 className="text-sm font-bold">メンバー</h2>
            </div>
            <ul className="max-h-[calc(100vh-10rem)] overflow-y-auto">
              {roster.map((r) => (
                <li key={r.id} className="tk-sep px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={"h-2 w-2 shrink-0 " + (r.state === "off" ? "bg-stone-300" : STATE_DOT[r.state])} />
                    {r.talk && TALK_TAG[r.talk] && (
                      <span
                        className="shrink-0 px-1 text-[9px] text-white"
                        style={{ background: "var(--tk-ink)", color: "var(--tk-paper)" }}
                      >
                        {TALK_TAG[r.talk]}
                      </span>
                    )}
                    <span className="truncate text-xs font-bold">{r.name}</span>
                  </div>
                  <p
                    className="mt-0.5 line-clamp-2 pl-4 text-xs"
                    style={{ color: r.note ? "var(--tk-ink)" : "var(--tk-ink-soft)" }}
                    title={r.note || undefined}
                  >
                    {r.note || "未記入"}
                  </p>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>

      {/* 画面下部。説明文は置かない（説明が要るUIは直す側）*/}
      <nav className="tk-head fixed inset-x-0 bottom-0 flex items-center gap-2 border-t px-4 py-1.5 text-xs">
        {autoAway && (
          <span className="border border-[var(--tk-ink)] px-2 py-0.5" style={{ background: "var(--tk-straw)" }}>
            {IDLE_MINUTES}分操作がないため離席にしました
          </span>
        )}
        {callNotice && (
          <span className="border border-[var(--tk-ink)] px-2 py-0.5" style={{ background: "var(--tk-paper)" }} role="status">
            {callNotice}
          </span>
        )}
        {answered && (
          <span className="border border-[var(--tk-ink)] px-2 py-0.5" style={{ background: "var(--tk-paper)" }} role="status">
            {nameOf(answered.id)} から {answered.text}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setZoom((z) => (z === "fit" ? "close" : "fit"))}
            className="tk-btn tk-btn-quiet"
            title="村の見え方を切り替える"
          >
            {zoom === "fit" ? "寄る" : "全体を見る"}
          </button>
          {/* 「メンバー」だけでは押す動機が見えないので、村にいる人数を添える */}
          <button onClick={() => setShowRoster((v) => !v)} className={"tk-btn " + (showRoster ? "tk-btn-on" : "tk-btn-quiet")}>
            メンバー {inVillage}/{roster.length}
          </button>
        </span>
      </nav>
      <div className="h-8" />

      {/* 噴水のお知らせ。流れて消えない（重要な連絡に向かないため）*/}
      {showAnns && (
        <div className="fixed inset-0 z-30 flex items-center justify-center" style={{ background: "rgba(51,48,42,0.45)" }}>
          <div className="tk-panel flex max-h-[80vh] w-[32rem] flex-col p-0">
            <div className="tk-head flex items-center px-3 py-2">
              <h2 className="text-sm font-bold">村のお知らせ</h2>
              <button onClick={() => setShowAnns(false)} className="tk-btn tk-btn-quiet ml-auto px-2 py-0.5 text-xs">閉じる</button>
            </div>
            <ul className="flex-1 overflow-y-auto">
              {anns.length === 0 && (
                <li className="px-3 py-6 text-center text-xs" style={{ color: "var(--tk-ink-soft)" }}>
                  お知らせはまだありません
                </li>
              )}
              {anns.map((a) => (
                <li key={a.id} className="tk-sep px-3 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-bold">{a.displayName}</span>
                    <span className="text-[11px] tabular-nums" style={{ color: "var(--tk-ink-soft)" }}>
                      {new Date(a.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm leading-6" style={{ wordBreak: "break-word" }}>{a.body}</p>
                </li>
              ))}
            </ul>
            {/* 書けるのは管理者のみ。ここで隠すのは見せ方の話で、
                書けるかどうかの判定はAPI側で行っている */}
            {annCanWrite && (
              <div className="border-t border-[var(--tk-ink)] p-2">
                <div className="flex gap-2">
                  <input
                    value={annInput}
                    onChange={(e) => setAnnInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void postAnn(); }}
                    placeholder="全員に知らせること（200文字まで）"
                    className="tk-input flex-1 text-sm"
                  />
                  <button onClick={postAnn} className="tk-btn text-sm">出す</button>
                </div>
                {annError && <p className="mt-1 text-xs font-bold" style={{ color: "var(--tk-red)" }}>{annError}</p>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 呼びかけを受けたとき。相手の返事だけが通話を始められる（近接では始まらない）*/}
      {incoming && (
        <div className="fixed inset-0 z-30 flex items-center justify-center" style={{ background: "rgba(51,48,42,0.45)" }}>
          <div className="tk-panel w-80 p-4">
            <p className="text-sm font-bold">{nameOf(incoming.id)} さんが呼びかけています</p>
            {incoming.knewFocus && (
              <p className="mt-1 text-[11px]" style={{ color: "var(--tk-red)" }}>
                集中中と分かったうえで呼びかけています
              </p>
            )}
            <p className="mt-2 text-xs" style={{ color: "var(--tk-ink-soft)" }}>
              返事をしても通話は始まりません（通話は次の段階で作ります）
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => { send({ type: "call.respond", to: incoming.id, answer: "accept" }); setIncoming(null); }}
                className="tk-btn flex-1 justify-center"
              >
                いま話せます
              </button>
              <button
                onClick={() => { send({ type: "call.respond", to: incoming.id, answer: "later" }); setIncoming(null); }}
                className="tk-btn tk-btn-quiet flex-1 justify-center"
              >
                あとで
              </button>
              <button
                onClick={() => { send({ type: "call.respond", to: incoming.id, answer: "decline" }); setIncoming(null); }}
                className="tk-btn tk-btn-quiet flex-1 justify-center"
              >
                いまは難しい
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
