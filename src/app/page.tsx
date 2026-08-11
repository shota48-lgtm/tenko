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
import {
  drawVillage, drawGround, drawNoteMarks, bubbleLayoutFor, hitBuilding, hitPerson,
  buildingRects, clampToVillage,
  VILLAGE_W, VILLAGE_H, PERSON_SIZE,
  type Presence, type Room, type NoteMap, type TalkStatus, type RoomCounts, type OccupantsMode,
} from "@/village/render";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";
const SCALE = 2;
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
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [callNotice, setCallNotice] = useState<string | null>(null);
  const [answered, setAnswered] = useState<{ id: number; text: string } | null>(null);
  // 集中中の相手に呼びかける前の確認
  const [confirmCall, setConfirmCall] = useState<number | null>(null);
  // 建物の中の人の見せ方。案2（隠して、乗せたときに人数と名前を出す）を採った。
  // 案1（重ねて描く）は、建物が32ドット四方なのに人物が32ドットあり、
  // 定員4でも建物が完全に隠れ、定員12では人物同士も潰れて誰も読めなくなる（実機で確認）。
  // 比較のため ?debug=1 では切り替えられるようにしてある
  const [occupants, setOccupants] = useState<OccupantsMode>("hide");
  const [bubbleMax, setBubbleMax] = useState(BUBBLE_MAX);
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

  const send = useCallback((obj: unknown) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }, []);

  const announce = useCallback((state: Presence["state"], talkStatus: TalkStatus) => {
    return send({ type: "presence.set", user: userRef.current, state, roomId: null, talk: talkStatus });
  }, [send]);

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
    }, 0);
    return () => clearTimeout(t);
  }, [loadNotes, router]);

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
    const t = setInterval(() => { void loadNotes(); }, 30_000);
    return () => clearInterval(t);
  }, [loadNotes]);

  // 建物の中の人を隠す案（案2）では、その人の吹き出しも出さない。
  // マウスを乗せている人は先頭に回し、上限に関係なく必ず出す
  // （常時出すのは3件までだが、見たい人のものは必ず読めるようにするため）
  const bubblePeople = useMemo(() => {
    const base = occupants === "hide" ? people.filter((p) => p.roomId == null) : people;
    if (hoverPerson == null) return base;
    const hit = base.find((p) => Number(p.id) === hoverPerson);
    return hit ? [hit, ...base.filter((p) => p !== hit)] : base;
  }, [people, occupants, hoverPerson]);
  const layout = useMemo(
    () => bubbleLayoutFor(rooms, bubblePeople, notes, bubbleMax),
    [rooms, bubblePeople, notes, bubbleMax],
  );

  // 地面は変わらないので一度だけ描いて使い回す（毎回描くと約27万回になり固まる）
  const ground = useMemo(() => {
    if (typeof document === "undefined") return null;
    const off = document.createElement("canvas");
    off.width = VILLAGE_W;
    off.height = VILLAGE_H;
    const octx = off.getContext("2d");
    if (!octx) return null;
    drawGround(octx, sheet(variant));
    return off;
  }, [variant]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, VILLAGE_W, VILLAGE_H);
    if (ground) ctx.drawImage(ground, 0, 0);
    drawVillage(ctx, sheet(variant), rooms, people, !ground, counts, occupants);
    drawNoteMarks(ctx, sheet(variant), layout);
  }, [rooms, people, variant, layout, ground, counts, occupants]);

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
        // 離した位置は必ず送る（間引きで最後の1件が落ちないように）
        send({ type: "presence.move", x: to.x, y: to.y });
      }
      dragRef.current = null;
      setDrag(null);
      lastActiveRef.current = Date.now();
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
    const shown = occupants === "hide"
      ? layout.spots.filter((s) => s.p.roomId == null)
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
        {debug && (
          <span className="ml-auto flex items-center gap-2 text-[11px]">
            <button onClick={() => setOccupants((v) => (v === "show" ? "hide" : "show"))} className="tk-btn tk-btn-quiet px-1.5 py-0.5">
              建物の中: {occupants === "show" ? "案1 重ねて描く" : "案2 隠す"}
            </button>
            <button onClick={() => setBubbleMax((v) => (v === 3 ? 5 : v === 5 ? 8 : 3))} className="tk-btn tk-btn-quiet px-1.5 py-0.5">
              吹き出し {bubbleMax}件
            </button>
            {(["a", "b", "c"] as const).map((k) => (
              <button key={k} onClick={() => setVariant(k)} disabled={k === variant} className={"tk-btn px-1.5 py-0.5 " + (k === variant ? "tk-btn-on" : "tk-btn-quiet")}>
                {k.toUpperCase()} {VARIANTS[k].meta.name}
              </button>
            ))}
          </span>
        )}
      </header>

      <div className="flex items-start gap-3 p-3">
        <div className="tk-panel max-h-[calc(100vh-6.5rem)] overflow-auto bg-black">
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
                    style={{ background: t.talk === "focus" ? "var(--tk-red)" : "var(--tk-wood)" }}
                  >
                    {TALK_TAG[t.talk]}
                  </span>
                )}
                <span
                  className="px-1 text-[10px] leading-[12px] text-white"
                  style={{ background: t.isMe ? "var(--tk-ink)" : "rgba(51,48,42,0.8)", color: t.isMe ? "#f2d489" : "#fff" }}
                >
                  {t.name}
                </span>
              </div>
            ))}

            {/* 今日やること */}
            {layout.boxes.map((b) => {
              const half = (b.w * SCALE) / 2;
              const cx = b.tailX * SCALE;
              const right = VILLAGE_W * SCALE;
              let left = cx;
              let tx = "-50%";
              if (cx - half < 2) { left = 2; tx = "0"; }
              else if (cx + half > right - 2) { left = right - 2; tx = "-100%"; }
              return (
                <div
                  key={b.userId}
                  className="pointer-events-none absolute border border-[var(--tk-ink)] px-1 py-0.5
                             text-[11px] leading-[13px]"
                  style={{
                    left, top: b.tailY * SCALE, transform: `translate(${tx}, -100%)`,
                    maxWidth: 190, whiteSpace: "pre-wrap", wordBreak: "break-word",
                    background: "var(--tk-paper)", color: "var(--tk-ink)",
                  }}
                >
                  {b.lines.join("")}
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
                        <p className="mt-0.5 text-[10px]" style={{ color: "var(--tk-ink-soft)" }}>
                          いまは建物の中なので会議中です。出れば戻ります
                        </p>
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
                        style={{ background: r.talk === "focus" ? "var(--tk-red)" : "var(--tk-wood)" }}
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
        <span className="ml-auto">
          <button onClick={() => setShowRoster((v) => !v)} className={"tk-btn " + (showRoster ? "tk-btn-on" : "tk-btn-quiet")}>
            メンバー
          </button>
        </span>
      </nav>
      <div className="h-8" />

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
