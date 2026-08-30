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
import { applyDrift, buildDriftPlan, driftOffsetsAt, type DriftPlan } from "@/village/demo-drift";
import SidePanel, { SIDE_PANEL_W } from "./side-panel";
import type { MonthlyResult } from "@/lib/monthly-format";
import {
  startVoice, nextVoicePhase, voiceStatusText,
  createHeldSignal, sendOrHold, resendHeld,
  type VoiceCall, type VoicePhase,
} from "@/lib/webrtc";
import { playRing } from "@/lib/ring";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";
// 村の拡大率。
//
// 2倍で固定していたところ、村（640x416）が 1280x832 になり、画面に収まらず縦にスクロールした。
// 全員がどこにいるか一目で分かることが村の唯一の価値なので、既定は「全体が入る」にする。
// 整数倍でないと1ドットの大きさが揃わないが、収まらないよりは良い（PHASE49_LOG.md に記載）。
// 「誰も漂わせない」状態。性能比較のときに使い回す（毎フレーム作らない）
const EMPTY_DRIFT_PLAN: DriftPlan = new Map();
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

// 誰として村にいるかは、サーバー側（page.tsx）が決めてここへ渡す。
// **画面側で利用者を決める仕組みは持たない**（Phase 5 段階3で devUser() を削除した。
// 以前は URL の ?me= を読んでおり、誰にでもなりすませた）。
export type Me = { id: number; name: string; role: string; colorIndex: number };

// 未ログインのときに使う置き。id=0 は誰とも一致しないため、
// 「自分」として描かれる人がいない状態になる
const GUEST: Me = { id: 0, name: "", role: "", colorIndex: 1 };

function isDebug() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("debug") === "1";
}

const menuBtn = "tk-btn tk-btn-quiet w-full justify-start text-xs";
const menuBtnOn = "tk-btn tk-btn-on w-full justify-start text-xs";

// 部屋の一覧はサーバー側で読んで渡す。
//
// 画面側で /api/rooms を取りに行っていたところ、到着まで1.4秒かかり（実測）、
// その間は建物のない村が描かれていた。POが開いた直後の画面がこの状態だった。
// 建物の配置は村の骨組みであり、後から届く情報にしてはいけない。
export default function VillagePage({
  initialRooms, initialPeople, initialCounts, me: sessionMe,
}: {
  initialRooms: Room[];
  // デモ用の在席。ws-server が寝ていても村に人がいるように、最初のHTMLに載せて渡す（段階7）
  initialPeople: Presence[];
  initialCounts: RoomCounts;
  me: Me | null;
}) {
  const router = useRouter();
  // ログインしていない人は「見るだけ」。村は見えるが、自分のアバターは出ない
  const isGuest = sessionMe === null;
  const me = sessionMe ?? GUEST;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 村の canvas と、その上に重ねる名前・吹き出しを収めている入れ物。
  // 漂わせるとき、canvas と重ね物を同じ量だけ動かすために掴んでおく
  const stageRef = useRef<HTMLDivElement | null>(null);
  const driftPlanRef = useRef<DriftPlan>(new Map());
  const [variant, setVariant] = useState<"a" | "b" | "c">(ACTIVE_VARIANT);
  const [rooms] = useState<Room[]>(initialRooms);
  const [users, setUsers] = useState<User[]>([]);
  // 初期値はサーバーから渡ったデモ用の在席。WS が繋がれば丸ごと置き換わる。
  // 置き換えても同じ座標・同じ状態が入るため、村はちらつかない（実機で確認）
  const [people, setPeople] = useState<Presence[]>(initialPeople);
  const [counts, setCounts] = useState<RoomCounts>(initialCounts);
  const [notes, setNotes] = useState<NoteMap>({});
  const [conn, setConn] = useState<"接続中" | "切断" | "再接続中">("再接続中");
  const [myState, setMyState] = useState<Presence["state"]>("idle");
  const [talk, setTalk] = useState<TalkStatus>("ok");
  const [stale, setStale] = useState(false);
  const [noteInput, setNoteInput] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteSaved, setNoteSaved] = useState(false);
  const [autoAway, setAutoAway] = useState(false);
  const [debug, setDebug] = useState(false);
  // セッションが切れた（開いたまま7日が過ぎた・DBの行が消された）。黙って古い画面を映し続けない
  const [sessionLost, setSessionLost] = useState(false);
  // 一度でも WS が繋がったか。最初の接続と、繋がったあとの切断を区別するために持つ
  const [everConnected, setEverConnected] = useState(false);
  // 在席の同期が止まった（auth.expired を受けた）。村が空に見えることと区別する
  const [syncStopped, setSyncStopped] = useState(false);
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
  // いまの通話（段階2）。**音はまだ出ない。**状態と表示だけを持つ。
  //   peerId : 相手の利用者ID。名前はここに持たない（表示のたびにDBの表示名で引く）
  //   role   : 自分が呼びかけた側か、受けた側か。段階3で「どちらが offer を作るか」に使う
  // 通話していないときは null。1件しか持たない（同時に2人とは話さない）
  const [call, setCall] = useState<{ peerId: number; role: "caller" | "callee" } | null>(null);
  // いま通話中なので呼びかけを受けなかった、という知らせ。黙って捨てると着信に気づけない
  const [missed, setMissed] = useState<number | null>(null);
  // 自分の音声を止めているか。**通話ごとに false から始める**（前の通話の状態を持ち越さない）。
  // 相手には送らない（段階1のメッセージの型を増やさない）。相手からは「無音」に聞こえる
  const [muted, setMuted] = useState(false);
  // マイクが使えていないか（段階5の後半）。通話ごとに調べ直す。
  // 真でも通話は続く（相手の声は聞こえる）。こちらの声だけが届かない
  const [micUnavailable, setMicUnavailable] = useState(false);
  // どの呼びかけで音を鳴らしたか。**1回の呼びかけにつき1回だけ鳴らす**ための控え。
  // 開発時は StrictMode が処理を2回走らせるため、回数を数えるだけでは足りない
  const ringedForRef = useRef<number | null>(null);
  // 通話の接続の状態（段階5の前半）。**画面に出すのはこれだけで、音は出さない。**
  //
  // 「繋がった」= connected になったこと。「繋がらなかった」= failed になったこと。
  // 「切れた」= 一度 connected になった後に disconnected か failed になったこと。
  //   connecting : つないでいます
  //   connected  : つながりました
  //   failed     : 一度も繋がらずに失敗した
  //   lost       : 繋がった後に切れた
  // 繋がらなかった場合と切れた場合を分けるため、一度でも connected になったかを控える
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("connecting");
  // 判定に渡す「いまの段階」。state は次の描画まで新しい値にならないため、控えを持つ
  const voicePhaseRef = useRef<VoicePhase>("connecting");
  const everConnectedRef = useRef(false);
  // 通話が既に終わっているか。文言を数秒残す間だけ真になる。
  // この間はボタンを出さない（押しても効かないため）
  const [callEnded, setCallEnded] = useState(false);
  // 文言を消すための時計。通話をやり直したときに前の時計が残らないよう、必ず片付ける
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 集中中の相手に呼びかける前の確認
  const [confirmCall, setConfirmCall] = useState<number | null>(null);
  // 村の拡大率。"fit" は画面に全体が入る大きさ、"close" は2倍（スクロールする）
  const [zoom, setZoom] = useState<"fit" | "close">("fit");
  const [fitScale, setFitScale] = useState(ZOOM_CLOSE);
  // 窓の幅。サイドパネルを村の隣に置けるかの判定にだけ使う。
  // **拡大率の計算には入れない**（入れると、パネルを出した分だけ村が小さくなる）
  const [winW, setWinW] = useState(0);
  // 自分の今月の勤怠（合計だけ）。取れなかったときは null のままにし、パネルを出さない
  const [monthly, setMonthly] = useState<MonthlyResult["total"] | null>(null);
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
  // 役割はサーバーから渡ってくる。/api/me を叩き直さない。
  // これは画面の分岐（承認への導線を出すか）にしか使わない。権限の判定はAPI側
  const myRole = sessionMe?.role ?? null;

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

  // WebSocket の受信の中から「いま通話中か」を見るための控え。
  // 受信の登録は繋ぎ直しのときしか作り直さないため、state を直接見ると古い値が残る
  const callRef = useRef<{ peerId: number; role: "caller" | "callee" } | null>(null);
  // 名前を引きに行った利用者ID。同じIDで何度も取りに行かないために覚える
  const triedNamesRef = useRef<Set<number>>(new Set());
  // いま呼びかけている相手。**この中の人からの「いま話せます」でだけ通話に入る。**
  // 呼びかけていない相手の承認や、自分の別の接続からの返事で通話に入らないための控え
  const invitedRef = useRef<Set<number>>(new Set());
  // 音声の接続（段階3）。**マイクを掴んでいるのはこの中だけ。**
  // 通話していない間は必ず null にする
  const voiceRef = useRef<VoiceCall | null>(null);
  // 接続ができる前に届いた合図を溜める場所。
  // 承認した側は即座に offer を送るが、呼びかけた側はマイクの許可を待っている間に
  // それを受け取ることがある。捨てると通話が始まらない
  const pendingSignalsRef = useRef<{ kind: "offer" | "answer" | "candidate"; value: unknown }[]>([]);
  // WebSocket が閉じている間に送れなかった、つなぎ直しに関わる合図の控え（段階6の改修）。
  // **最新の1件だけを持つ。** 繋がり直したときに送り直し、控えは消す。
  // 何を控えるか・いつ送り直すかの判定は webrtc.ts にある。ここは入れ物を持つだけ
  const heldSignalRef = useRef(createHeldSignal());
  // 相手の声を鳴らす要素。canvas には音を出せないので DOM に置く
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => { callRef.current = call; }, [call]);

  useEffect(() => { myStateRef.current = myState; }, [myState]);
  useEffect(() => { talkRef.current = talk; }, [talk]);
  useEffect(() => { userRef.current = me; }, [me]);

  // 「いま操作した」を記録する。描画中に Date.now() を呼ばないための入れ物
  const touchActivity = useCallback(() => { lastActiveRef.current = Date.now(); }, []);

  // 送れなかった場合、つなぎ直しに関わる合図だけを控える（段階6の改修）。
  // **判定は webrtc.ts の sendOrHold が持っている。ここでは呼ぶだけ**
  const send = useCallback((obj: unknown) => {
    return sendOrHold(wsRef.current, obj, heldSignalRef.current);
  }, []);

  const announce = useCallback((state: Presence["state"], talkStatus: TalkStatus) => {
    // 見るだけの人は村に現れない。在席を申告しない（Phase 5 段階3）。
    // ws-server 側の検証は段階6で入れる。ここで送らないのは体験のためであって、担保ではない
    if (isGuest) return false;
    return send({ type: "presence.set", user: userRef.current, state, roomId: null, talk: talkStatus });
  }, [send, isGuest]);

  // 音声の接続を閉じる（段階3）。**マイクを止めるのはここ1か所に集める。**
  // 切ったとき・相手が切ったとき・画面を離れるときの3つから呼ぶ
  const closeVoice = useCallback(() => {
    voiceRef.current?.close();
    voiceRef.current = null;
    pendingSignalsRef.current = [];
    // 送れずに控えてあった合図も捨てる（段階6の改修）。
    // 通話が終わった後に送り直すと、閉じた接続に対する接続情報を送ることになる
    heldSignalRef.current.held = null;
    // 次の通話はミュートしていない状態から始める
    setMuted(false);
    // マイクの可否は通話ごとに調べ直す。前の通話の結果を持ち越さない
    setMicUnavailable(false);
    const a = audioRef.current;
    if (a) { a.pause(); a.srcObject = null; }
  }, []);

  // 呼びかけを受けたときに音を鳴らす（段階5の後半）。
  //
  // **呼びかけを受けた側でしか鳴らない。** incoming が立つのは受けた側だけで、
  // 呼びかけた側にはこの状態が無い（呼びかけた側は call.answered を待つ）。
  //
  // 1回の呼びかけにつき1回だけ鳴らす。ringedForRef で見張るのは、
  // 開発時に StrictMode がこの処理を2回走らせるため。回数を数えるだけでは足りない。
  // 鳴らせなかった場合は ring.ts の中で握られ、画面には何も出ない
  useEffect(() => {
    if (!incoming) { ringedForRef.current = null; return; }
    if (ringedForRef.current === incoming.id) return;
    ringedForRef.current = incoming.id;
    void playRing();
  }, [incoming]);

  // 呼びかけを受けている間、タブの見出しを変える（段階5）。
  //
  // 別のタブを見ているときに気づけるようにする。音は端末の設定で鳴らないことがあるが、
  // 見出しは必ず変わる。
  //
  // **元の見出しは控えておいて戻す。決め打ちの文字列で上書きしない。**
  //   村の見出しが将来変わったときに、ここが古い値を書き戻す形になるため。
  // 片付け（return の中）は、呼びかけが消えたとき・通話に入ったとき・
  // 画面を離れたときのいずれでも走る
  useEffect(() => {
    if (!incoming) return;
    const original = document.title;
    document.title = "呼びかけ中です - tenko";
    return () => { document.title = original; };
  }, [incoming]);

  // 通話にまつわる控えを、次の通話のために全部戻す（段階5の前半）。
  // closeVoice と分けてあるのは、closeVoice が「マイクを離す」ことだけに責任を持つため
  const resetVoiceState = useCallback(() => {
    if (endTimerRef.current !== null) { clearTimeout(endTimerRef.current); endTimerRef.current = null; }
    everConnectedRef.current = false;
    voicePhaseRef.current = "connecting";
    setVoicePhase("connecting");
    setCallEnded(false);
  }, []);

  // 接続の状態から出す文言（段階5）。**文言も判定も webrtc.ts に置いてある。**
  // ここで組み立てると、状態の出どころと表示が離れて、ずれても気づけなくなる
  const voiceStatus = voiceStatusText(voicePhase);

  // ミュートの切り替え。**画面側からトラックを直接触らない**（webrtc.ts の VoiceCall を通す）
  //
  // **副作用（v.setMuted）を、状態の更新関数の中で呼ばない。**
  //   開発時は StrictMode が更新関数を意図的に2回呼ぶため、中に置くと
  //   マイクの切り替えとログが1回の操作で2回走る（本番では1回。動作の誤りではないが、
  //   記録が二重に出て切り分けの邪魔になる）。
  //   いまの状態は画面の state ではなく **VoiceCall に聞く**（isMuted）。
  //   トラックの enabled が本体で、state はその写しであるため、本体を正とする
  const toggleMute = useCallback(() => {
    const v = voiceRef.current;
    if (!v) return;
    const next = !v.isMuted();
    v.setMuted(next);
    setMuted(next);
  }, []);

  // 届いた合図をブラウザに渡す。**中身は見ない。**
  const applySignal = useCallback(async (kind: "offer" | "answer" | "candidate", value: unknown) => {
    const v = voiceRef.current;
    if (!v) return;
    try {
      if (kind === "offer") await v.handleOffer(String(value ?? ""));
      else if (kind === "answer") await v.handleAnswer(String(value ?? ""));
      else await v.addCandidate(value);
    } catch (e) {
      // 段階3では画面に出さない。出し方は段階5で決める
      console.warn("[voice] 合図を適用できなかった: " + kind, e);
    }
  }, []);

  // セッションが切れたとき。
  //
  // 段階3で、チャットが 401 を「送り直しても通らない4xx」に含めていて
  // 書いた文が黙って消えていた。同じ形の失敗を村でも作らない。
  // 401 を黙って捨てると、開いたままの画面が古い情報を映し続け、
  // 操作だけが通らない状態になる（何が起きたか利用者に分からない）
  const noteSessionLost = useCallback((status: number) => {
    if (status === 401) setSessionLost(true);
    return status === 401;
  }, []);

  // 未読と勤怠の下書き。村に出すために定期的に取り直す
  const loadVillage = useCallback(async () => {
    try {
      const res = await fetch("/api/village");
      if (noteSessionLost(res.status)) return;
      if (!res.ok) return;
      const d = await res.json();
      setUnread(d.unread ?? {});
      setDrafts(d.drafts ?? []);
    } catch { /* 取れなくても村は描く */ }
  }, [noteSessionLost]);

  const loadAnns = useCallback(async () => {
    try {
      const res = await fetch("/api/announcements");
      if (noteSessionLost(res.status)) return;
      if (!res.ok) return;
      const d = await res.json();
      setAnns(d.announcements ?? []);
      setAnnUnread(Number(d.unread ?? 0));
      setAnnCanWrite(d.canWrite === true);
    } catch { /* 取れなくても村は描く */ }
  }, [noteSessionLost]);

  // 利用者の一覧（表示名を引く元）。
  //
  // **開いたときの1回だけでは足りない。**
  // 画面を開いた後に追加された利用者は一覧に入らず、その人の名前が引けないまま残る。
  // 名前が引けないと nameOf が「利用者58」のようにIDを出す。
  // 実際にそうなった（利用者を1人足した後、開いたままの画面が 56人の一覧を持ち続けた）。
  // そこで、知らない利用者が現れたときに取り直せるよう、関数として切り出す
  const loadUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/users");
      if (!res.ok) return;
      const d = await res.json();
      setUsers(d.users ?? []);
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
      setDebug(isDebug());
      // 名前と吹き出しは村の絵の一部なので、ログインしていなくても読む
      void loadUsers();
      void loadNotes();
      // ここから下は自分の情報。ログインしている人だけが叩く。
      // 叩いても 401 が返るだけだが、無駄な要求を出さない
      if (isGuest) return;
      void fetch("/api/notes?mine=1").then((r) => r.json())
        .then((d) => setNoteInput(d.note?.body ?? "")).catch(() => {});
      void loadVillage();
      void loadAnns();
      // 今月の勤怠。**開いたときの1回だけ**取る。
      // 30秒ごとの取り直し（loadNotes / loadVillage）には入れない。
      // 月の集計は頻繁に変わらず、呼び出し回数を増やすだけになるため。
      // 失敗しても何も出さない（村が主役で、これは補いのため）
      const now = new Date();
      void fetch(`/api/attendance/monthly?year=${now.getFullYear()}&month=${now.getMonth() + 1}&format=json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: MonthlyResult | null) => setMonthly(d?.total ?? null))
        .catch(() => { /* 取れなくても村は描く */ });
    }, 0);
    return () => clearTimeout(t);
  }, [loadNotes, loadVillage, loadAnns, loadUsers, router, isGuest]);

  // 名前の分からない利用者が現れたら、一覧を取り直す。
  //
  // 対象は「村にいる人」「通話の相手」「呼びかけてきた人」。
  // **一度試したIDは覚えておき、二度は取りに行かない。**
  // 覚えないと、本当に一覧に無いID（例: 消された利用者）が村に残っている間、
  // 30秒ごとに取り直し続けることになる。
  // 未ログインの人は対象外。名前が配られないのは仕様で、「メンバー」と出るのが正しい
  useEffect(() => {
    if (isGuest) return;
    const known = new Set(users.map((u) => u.id));
    const wanted = [
      ...people.map((p) => Number(p.id)),
      ...(call ? [call.peerId] : []),
      ...(incoming ? [incoming.id] : []),
    ];
    const missing = wanted.filter((id) => Number.isInteger(id) && id > 0
      && !known.has(id) && !triedNamesRef.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) triedNamesRef.current.add(id);
    void loadUsers();
  }, [users, people, call, incoming, isGuest, loadUsers]);

  // WebSocket。在席・位置・呼びかけを配る。
  //
  // Phase 5 段階6: 村に自分を出すには**入場券**が要る。
  //   券は同一オリジンの POST /api/ws-ticket で取り、
  //   new WebSocket(url, ["tenko.v1", "ticket." + 券]) の形で渡す。
  //   ブラウザは独自のヘッダを送れず、別ドメインの ws-server には Cookie も届かないため。
  //
  //   **未ログインの人は券を取りに行かない**（401 を無駄に踏まない）。券なしで繋ぎ、
  //   村を見るだけになる。券が取れなかった場合も同じ（村が見えなくなるより良い）。
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = 1000;
    // 券は使い捨て。繋ぎ直すたびに取り直す
    const getTicket = async (): Promise<string | null> => {
      if (isGuest) return null;
      try {
        const res = await fetch("/api/ws-ticket", { method: "POST" });
        if (!res.ok) {
          if (res.status === 401) setSessionLost(true);
          return null;
        }
        const d = await res.json();
        return typeof d.ticket === "string" ? d.ticket : null;
      } catch { return null; }
    };

    const connect = async () => {
      setConn("再接続中");
      const ticket = await getTicket();
      if (closed) return;
      // 券が無くても "tenko.v1" は必ず送る。
      // protocols を1つも送らないと、サーバの handleProtocols が呼ばれない（実測）
      const protocols = ticket ? ["tenko.v1", "ticket." + ticket] : ["tenko.v1"];
      const ws = new WebSocket(WS_URL, protocols);
      wsRef.current = ws;
      ws.onopen = () => {
        delay = 1000;
        setConn("接続中");
        setStale(false);
        setEverConnected(true);
        // 繋がり直したら、同期が止まっている表示は消す
        if (ticket) setSyncStopped(false);
        announce(myStateRef.current, talkRef.current);
        ws.send(JSON.stringify({ type: "presence.sync" }));
        // 閉じている間に送れなかった合図を送り直す（段階6の改修）。
        // **通話中かどうかだけをここで渡し、送るかどうかの判定は webrtc.ts が行う**
        resendHeld(ws, heldSignalRef.current, callRef.current !== null);
      };
      ws.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data as string);
          if (d.type === "presence.list") {
            // 同じ利用者が複数の端末から接続していても、村では1人として扱う
            const byId = new Map<number, Presence>();
            // **サーバーが最初のHTMLに載せたデモ用の人を、下敷きとして置く（段階7）。**
            //
            // WS の一覧で丸ごと置き換える形にしていたところ、
            // ws-server がアプリに到達できない状態（デモ用の一覧を取れない）で繋がると、
            // **空の一覧が届いて村が空になった**（実機で確認）。
            // 村が空に見えることは、勤怠のアプリでは「誰も働いていない」という誤った主張になる。
            //
            // デモ用の人はDBの行そのもので、生きている人のように増減しない。
            // WS が同じIDを送ってきたら、そちらで上書きされる（下の for が後に回る）
            for (const p of initialPeople) byId.set(Number(p.id), p);
            for (const p of (d.users ?? []) as Presence[]) byId.set(Number(p.id), { ...p, id: Number(p.id) });
            const merged = Array.from(byId.values());
            setPeople(merged);
            if (d.rooms) {
              // 建物の人数は、実際に描く人から数え直す。
              // サーバーの数字をそのまま使うと、上の下敷きで足した人のぶんだけ
              // 「帯は空なのに中に人がいる」状態になる
              const counts = d.rooms as RoomCounts;
              const fixed: RoomCounts = {};
              for (const [id, c] of Object.entries(counts)) {
                fixed[Number(id)] = {
                  ...c,
                  used: merged.filter((p) => Number(p.roomId) === Number(id)).length,
                };
              }
              setCounts(fixed);
            }
          } else if (d.type === "presence.denied") {
            // 満員・不正な座標など。押した本人にだけ返る
            setDenied(String(d.reason ?? "移動できませんでした"));
          } else if (d.type === "call.incoming") {
            // 通話中は新しい呼びかけを受けない（段階2）。
            // 受けると、いま話している相手との通話をどうするかを決める必要が出る。
            // **相手に「通話中です」と伝える手段が既存に無い**ため、呼びかけた側からは
            // 返事が来ないだけに見える。受けた側には、後から気づけるよう知らせを出す
            if (callRef.current) { setMissed(Number(d.from?.id)); return; }
            // 名前は受け取らない。IDだけを持ち、表示のときにDBの表示名で引く
            setIncoming({ id: Number(d.from?.id), knewFocus: d.knewFocus });
          } else if (d.type === "call.handled") {
            // 自分の別の端末が返事をした（段階2-D）。この端末の呼びかけの表示を閉じる。
            // 二重に応答すると、相手には2回返事が届く
            setIncoming(null);
            setCallNotice("他の端末で応答しました");
          } else if (d.type === "call.hangup") {
            // 相手が切った。音声の接続とマイクを先に閉じ、そのあと状態を解く（段階3）。
            // 接続の状態の控えもここで戻す（段階5。次の通話へ持ち越さない）
            closeVoice();
            resetVoiceState();
            setCall(null);
            setCallNotice("通話が終わりました");
          } else if (d.type === "call.offer" || d.type === "call.answer" || d.type === "call.candidate") {
            // 音声を繋ぐための合図（段階3）。**中身は解釈せず、そのままブラウザに渡す。**
            // 接続の用意ができていなければ溜めておく（マイクの許可を待っている間に届くため）
            const kind = d.type === "call.offer" ? "offer" : d.type === "call.answer" ? "answer" : "candidate";
            const value = kind === "candidate" ? d.candidate : d.sdp;
            if (voiceRef.current) void applySignal(kind, value);
            else pendingSignalsRef.current.push({ kind, value });
          } else if (d.type === "call.sent") {
            setCallNotice("呼びかけました。相手の返事を待っています");
          } else if (d.type === "call.denied") {
            setCallNotice(String(d.reason ?? "呼びかけられませんでした"));
          } else if (d.type === "call.answered") {
            const fromId = Number(d.from?.id);
            // **自分自身からの返事はあり得ない。**
            // ws-server の call.respond は、call.invite と違って宛先が自分でも通す
            // （to === from.id を弾いていない）。そのため自分の別の接続が返事を送ると、
            // 自分を相手とする「返事」が自分に届く。これを通すと
            // 通話中の相手が自分になり、両方の画面に同じ名前が出る（段階3の不具合）
            if (!Number.isInteger(fromId) || fromId <= 0 || fromId === userRef.current.id) {
              console.warn("[call] 自分自身からの返事を捨てた: id=" + fromId);
              return;
            }
            const a = d.answer === "accept" ? "「いま話せます」と返事がありました"
              : d.answer === "later" ? "「あとで」と返事がありました"
                : "「いまは難しい」と返事がありました";
            // ここも名前はDBの表示名で引く（届いた値をそのまま出さない）
            setAnswered({ id: fromId, text: a });
            // 「いま話せます」なら通話に入る（段階2）。呼びかけた側はここが入口。
            // **呼びかけた相手からの返事だけを受ける。**
            // 呼びかけていない相手の「承認」で通話に入ると、意図しない相手と繋がる
            if (d.answer === "accept") {
              if (!invitedRef.current.has(fromId)) {
                console.warn("[call] 呼びかけていない相手からの承認を捨てた: id=" + fromId);
                return;
              }
              invitedRef.current.clear();
              setCall({ peerId: fromId, role: "caller" });
            }
          } else if (d.type === "auth.expired" || d.type === "auth.rejected") {
            // セッションが無効になった／券が通らなかった。
            //
            // **close code に頼らない（段階7-B。本番で実測した）。**
            //   手元では close(4001) / close(4003) がそのまま画面に届く（spike/ws-auth-01）。
            //   **本番（Render 越し）では、こうなる:**
            //     この知らせ  : 254 ms で届く
            //     close      : **20,254 ms 後**に届き、しかも **code は 1006 に置き換わる**
            //   プロキシが close を20秒ほど遅らせ、コードを捨てている。
            //   close code を待つ形だと、券を取り直すまでに20秒かかり、
            //   しかも 4001 と 4003 の区別が失われる。
            //   したがって、**繋ぎ直しの引き金はこの知らせにする。** close code は届けば使う程度に留める。
            //
            // 画面にも出す。黙って切ると村が静かに空になり、
            // 勤怠のアプリで「誰も働いていない」という誤った主張になる
            console.warn("[ws] " + d.type + ": " + d.reason);
            if (!isGuest) setSyncStopped(true);
            // 自分から閉じる。onclose が動き、いつもの繋ぎ直しの経路に乗る
            try { ws.close(); } catch { /* 既に閉じている */ }
          }
        } catch { /* 解釈できない通知は捨てる */ }
      };
      ws.onclose = (e) => {
        if (closed) return;
        setConn("切断");
        setStale(true);
        // 4001（セッションが無効）と 4003（券が通らない）は、券を取り直せば入れることがある。
        // **すぐに繋ぎ直すのは1回だけ**。以後は間隔を倍にする（上限30秒）。
        // 空けないと、セッションが本当に無効なときに券の要求が際限なく増える。
        //
        // 本番では close code が届かないことがあるため（段階7-B）、
        // 知らせ（auth.expired / auth.rejected）を受けて自分で閉じた場合もここに来る。
        // その場合 e.code は 1005（コード無し）になるので、それも「取り直す」に含める
        const retryNow = (e.code === 4001 || e.code === 4003 || e.code === 1005) && delay === 1000;
        const wait = retryNow ? 500 : delay;
        timer = setTimeout(() => { delay = Math.min(delay * 2, 30_000); void connect(); }, wait);
      };
      ws.onerror = () => { /* close が続けて呼ばれる */ };
    };
    void connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [announce, isGuest, initialPeople]);

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
  // 受けられなかった呼びかけの知らせも、他の知らせと同じく数秒で消す
  useEffect(() => {
    if (missed == null) return;
    const t = setTimeout(() => setMissed(null), 6000);
    return () => clearTimeout(t);
  }, [missed]);

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
    const t = setInterval(() => { void loadNotes(); if (!isGuest) void loadVillage(); }, 30_000);
    return () => clearInterval(t);
  }, [loadNotes, loadVillage, isGuest]);

  // 画面に村全体が入る拡大率を測る。窓の大きさが変わるたびに測り直す
  useEffect(() => {
    const measure = () => {
      // ヘッダ・下部の帯・余白の分を引く。
      // 見積もりが12ドット甘く、2倍でちょうど1ドットはみ出してスクロールしていた（実測）
      const w = window.innerWidth - 40;
      const h = window.innerHeight - 120;
      const s = Math.min(w / VILLAGE_W, h / VILLAGE_H, ZOOM_CLOSE);
      setFitScale(Math.max(ZOOM_MIN, Math.floor(s * 20) / 20));
      setWinW(window.innerWidth);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const SCALE = zoom === "close" ? ZOOM_CLOSE : fitScale;

  // サイドパネルを出すかどうか。
  //
  // 村の大きさは先に決まっている（上の測り方は変えていない）。
  // その村を置いたうえで 300px が余るかどうかだけで決める。並べられないなら出さない。
  // 内訳: 外側の余白 p-3 が左右で 24px、村との隙間 gap-3 が 12px、
  //       メンバー一覧を開いていれば その幅 288px（w-72）と隙間 12px
  const sidePanelMinW = VILLAGE_W * SCALE + SIDE_PANEL_W + 12 + 24 + (showRoster ? 288 + 12 : 0);
  const showSidePanel = winW >= sidePanelMinW;

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

  // デモの人を漂わせる計画（拠点と安全振幅）。
  // **毎フレーム作り直さない。** 在席が更新されたときだけ計算し、ref に置く。
  // state にすると再レンダリングが走り、描画ループと競合する。
  useEffect(() => {
    driftPlanRef.current = buildDriftPlan(rooms, people);
    // 試験で「誰にどれだけの振幅が付いたか」を数値で確かめるための覗き口
    (window as unknown as { __driftPlan?: [number, { anchorX: number; anchorY: number; amp: number }][] })
      .__driftPlan = [...driftPlanRef.current.entries()];
  }, [rooms, people]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    let raf = 0;
    let first = true;

    const paint = () => {
      const dbg = window as unknown as { __driftOff?: boolean };
      // 漂いを止めた状態（＝改修前と同じ絵）と、所要時間を同じ土俵で比べるための切り替え。
      // 画面には出さない。試験で `window.__driftOff = true` と置いて計測する
      const plan = dbg.__driftOff ? EMPTY_DRIFT_PLAN : driftPlanRef.current;
      const t = Date.now();
      const p0 = performance.now();
      // **people の state は書き換えない。** 描画用に複製し、対象者の x, y だけ差し替える。
      // サーバー由来の値を汚すと、呼びかけ・定員・ドラッグの判定が壊れる
      const shown = applyDrift(people, plan, t);
      ctx.clearRect(0, 0, VILLAGE_W, VILLAGE_H);
      if (ground) ctx.drawImage(ground, 0, 0);
      const t0 = performance.now();
      drawVillage(ctx, sheet(variant), rooms, shown, !ground, counts, occupants, dropTarget, unread, me.id);
      const dt = performance.now() - t0;
      drawNoteMarks(ctx, sheet(variant), layout);

      // 名前と吹き出しは canvas ではなく DOM にある。
      // canvas だけずらすとラベルが置き去りになるため、同じ量だけ動かす。
      // React を経由せず style を直接書く（毎フレームの再レンダリングを避けるため）
      const host = stageRef.current;
      if (host) {
        const offs = driftOffsetsAt(plan, t);
        for (const el of Array.from(host.querySelectorAll<HTMLElement>("[data-drift-id]"))) {
          const d = offs.get(Number(el.dataset.driftId));
          el.style.translate = d ? `${d.dx * SCALE}px ${d.dy * SCALE}px` : "";
        }
      }

      const w = window as unknown as {
        __villagePositions?: [number, number | null, number | null][];
        __villagePaintCount?: number;
        __villagePaints?: { t: number; rooms: number; people: number }[];
        __villageDrawMs?: number[];
        __villagePaintMs?: number[];
      };
      // いま描いた座標。**上書きで持つ（積まない）。**
      // 「動いていないはずの人が動いていないこと」を目でなく数値で確かめるために置く
      // 描いた枚数。タブを裏にしたときに止まっているかを数で確かめるために置く
      w.__villagePaintCount = (w.__villagePaintCount ?? 0) + 1;
      w.__villagePositions = shown.map((p) => [Number(p.id), p.x ?? null, p.y ?? null]);
      // drawVillage 1回の所要時間と、1フレーム全体の所要時間。性能の比較（T7）に使う。
      // 120件で頭打ちにする（増え続けない）
      w.__villageDrawMs ??= [];
      if (w.__villageDrawMs.length < 120) w.__villageDrawMs.push(dt);
      w.__villagePaintMs ??= [];
      if (w.__villagePaintMs.length < 120) w.__villagePaintMs.push(performance.now() - p0);
      // 最初の数回の「描画の状態」を残す。
      // 「開いた直後に建物が無い」を後から測るための記録で、5回で止まる（増え続けない）。
      // rAF で毎フレーム描くようになったため、**状態が変わった直後の1回だけ**記録する
      // （毎フレーム積むと、開いて0.1秒で5件が埋まって意味を失う）
      if (first) {
        first = false;
        w.__villagePaints ??= [];
        if (w.__villagePaints.length < 5) {
          w.__villagePaints.push({ t: Math.round(performance.now()), rooms: rooms.length, people: people.length });
        }
      }
    };

    const loop = () => { paint(); raf = requestAnimationFrame(loop); };
    const start = () => { if (!raf) raf = requestAnimationFrame(loop); };
    const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
    // タブが裏にある間は回さない。見えていない絵に電池を使わない
    const onVis = () => { if (document.hidden) stop(); else { paint(); start(); } };
    document.addEventListener("visibilitychange", onVis);

    paint();                       // 最初の1枚は待たずに出す
    if (!document.hidden) start();
    return () => { document.removeEventListener("visibilitychange", onVis); stop(); };
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

  // 当たり判定に使う「いま描かれている位置」。
  //
  // 漂わせるのは描画だけなので、`people`（サーバー由来の値）を使って当てると
  // 見えている人と最大40pxずれ、押しても何も起きない（実測で判明）。
  // 押す・乗せるの判定だけ、描画と同じ位置で行う。**state は書き換えない。**
  // 掴めるのは自分だけで、自分は漂わせないため、ドラッグの判定には影響しない。
  const peopleAsDrawn = () => applyDrift(people, driftPlanRef.current, Date.now());
  /** その人の、拠点からのいまのずれ（漂っていない人は 0） */
  const driftOf = (id: number) => {
    const d = driftPlanRef.current.get(id);
    if (!d) return { dx: 0, dy: 0 };
    return driftOffsetsAt(driftPlanRef.current, Date.now()).get(id) ?? { dx: 0, dy: 0 };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const at = toVillage(e);
    const person = hitPerson(rooms, peopleAsDrawn(), at.x, at.y);
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
    const p = hitPerson(rooms, peopleAsDrawn(), at.x, at.y);
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
    const person = hitPerson(rooms, peopleAsDrawn(), at.x, at.y);
    if (person) {
      const spot = layout.spots.find((s) => Number(s.p.id) === Number(person.id));
      // 案内を出す位置も、拠点ではなく見えている位置に合わせる
      const o = driftOf(Number(person.id));
      setPicked({ id: Number(person.id), x: (spot?.x ?? at.x) + o.dx, y: (spot?.y ?? at.y) + o.dy });
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
      body: JSON.stringify({ body: noteInput }),
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
      body: "{}",
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

  // 表示名はDBから引く（自己申告の名前を画面に出さない）。
  //
  // 未ログインの人には、実在の利用者の名前が配られない（/api/users がデモ用の分しか返さない）。
  // そのとき「利用者3」のように利用者IDを出すと、名前の代わりにIDを配ることになる。
  // 名前が引けない相手は「メンバー」とだけ出す（Phase 5 段階4）
  const nameOf = useCallback(
    (id: number) => users.find((u) => u.id === id)?.displayName ?? (isGuest ? "メンバー" : "利用者" + id),
    [users, isGuest],
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

  // 噴水を押したとき。開いた時点で既読にする。
  // 未ログインでも押せる（押せることは分かる）が、中身は見せない。
  // お知らせは社内の連絡であり、村を見ただけの人に配るものではない（POの判断）
  const openAnns = async () => {
    setShowAnns(true);
    if (isGuest) return;
    await fetch("/api/announcements", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
    await loadAnns();
  };

  // ログアウト。Auth.js の signOut は Server Action か クライアント関数だが、
  // ここは村の画面（Client Component）なので、素直に POST を投げる。
  // CSRF トークンは Auth.js が Cookie と一緒に持っている（同一オリジンなので送られる）
  const doSignOut = async () => {
    try {
      const c = await fetch("/api/auth/csrf").then((r) => r.json());
      await fetch("/api/auth/signout", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrfToken: c.csrfToken, callbackUrl: "/" }).toString(),
      });
    } catch { /* 失敗しても、下の再読み込みで状態は正される */ }
    // 村に「自分」が残らないよう、在席を消してから読み直す。
    // router.refresh() で page.tsx（Server Component）が動き直し、
    // セッションが無い状態＝見るだけの村として描かれる
    send({ type: "presence.set", user: userRef.current, state: "off" });
    setPicked(null);
    router.refresh();
  };

  const postAnn = async () => {
    setAnnError(null);
    const res = await fetch("/api/announcements", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: annInput }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setAnnError(j.error ?? "書けませんでした");
      return;
    }
    setAnnInput("");
    await loadAnns();
  };

  const decideDraft = async (id: number, action: "confirm" | "reject") => {
    await fetch("/api/attendance/drafts/" + id, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    await loadVillage();
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
  // 通話を切る（段階2）。
  // 自分の状態を先に解いてから相手に知らせる。送れなかった場合でも、
  // 自分の画面が「通話中」のまま残らないようにするため
  const hangUp = useCallback(() => {
    const peer = callRef.current?.peerId;
    // 音声とマイクを先に止める。相手に知らせる前に止めることで、
    // 送信に失敗しても自分のマイクが掴まれたままにならない（段階3）
    closeVoice();
    resetVoiceState();
    setCall(null);
    if (peer != null) send({ type: "call.hangup", to: peer });
  }, [send, closeVoice, resetVoiceState]);

  // 繋がらなかったとき・切れたときに通話を終える（段階5）。
  //
  // ここで3つを行う。順序に意味がある。
  //   1. マイクを離す（closeVoice）。**先に離す。** 送信に失敗しても掴んだままにならない
  //   2. 相手へ通話を切る合図を送る。片側だけ「通話中」のまま残らないようにする
  //   3. 文言を数秒だけ残してから、通話中の表示を消す。
  //      すぐ消すと、何が起きたのかを読む前に画面から無くなる
  const endCallAfterFailure = useCallback(() => {
    const peer = callRef.current?.peerId;
    closeVoice();
    setCallEnded(true);
    if (peer != null) send({ type: "call.hangup", to: peer });
    if (endTimerRef.current !== null) clearTimeout(endTimerRef.current);
    // 4秒。読んで理解できる長さで、かつ操作の邪魔にならない長さにする
    endTimerRef.current = setTimeout(() => {
      endTimerRef.current = null;
      setCall(null);
      setCallEnded(false);
      setVoicePhase("connecting");
      voicePhaseRef.current = "connecting";
      everConnectedRef.current = false;
    }, 4_000);
  }, [send, closeVoice]);

  // つなぎ直しの期限を過ぎたときの後始末（段階6）。
  //
  // **期限を数えているのは webrtc.ts。** 接続の状態を受け取っている側に判定を置いてある。
  // ここでやるのは、終わったことを画面に反映することだけ。
  // 終え方は、繋がらなかった場合と同じ道を通す
  // （マイクを離し、相手へ切る合図を送り、文言を数秒残す）
  const onReconnectGiveUp = useCallback(() => {
    voicePhaseRef.current = "lost";
    setVoicePhase("lost");
    endCallAfterFailure();
  }, [endCallAfterFailure]);

  // 通話の状態が立ったら音声を繋ぐ。**マイクを取るのはここだけ**（段階3）。
  //
  // 承認した側（callee）が接続情報を作って送り、呼びかけた側（caller）は待つ
  // （ws-messages.ts の設計メモ 2 のとおり）。
  // 許可を待っている間に相手の合図が届くことがあるので、溜めてあった分を後から流す。
  // 通話が終われば（call が null になれば）閉じる。マイクもここで止まる
  useEffect(() => {
    if (!call) { closeVoice(); return; }
    // 新しい通話の始まり。前の通話の控え（一度繋がったか・文言・時計）を持ち越さない
    resetVoiceState();
    let cancelled = false;
    void (async () => {
      try {
        // 中継サーバー（TURN）の使い捨ての合言葉を、**通話を始める直前に**取りに行く（段階4）。
        //
        // 開いたときにまとめて取らない理由:
        //   合言葉には期限がある。画面を開いたまま何時間も置かれると、
        //   いざ通話するときには切れている。通話1回につき1度取るのが確実で、
        //   呼び出し回数も通話の回数までにしかならない。
        //
        // **取れなくても通話を止めない。** 失敗したときと、合言葉が無いと返ってきたときは
        // STUN だけで始める（段階3と同じ動き）。直接つながる相手とはそれで繋がる
        let iceServers: RTCIceServer[] = [];
        try {
          const res = await fetch("/api/turn-credentials");
          if (res.ok) {
            const d = await res.json();
            iceServers = Array.isArray(d?.iceServers) ? d.iceServers : [];
          } else {
            console.warn("[voice] 中継の合言葉を取れなかった: status " + res.status + "（STUNのみで続ける）");
          }
        } catch (e) {
          console.warn("[voice] 中継の合言葉を取りに行けなかった（STUNのみで続ける）", e);
        }
        if (cancelled) return;

        const v = await startVoice({
          peerId: call.peerId,
          // つなぎ直しで、どちらが先に経路を作り直すかを決めるために渡す（段階6の改修）。
          // 決め方は webrtc.ts に置いてある（利用者IDの小さい側が先）。
          // ここでは値を渡すだけで、判定はしない
          selfId: userRef.current.id,
          role: call.role,
          iceServers,
          send: (m) => { send(m); },
          // 接続の状態を画面へ伝える（段階5）。**判定はここでは行わず、状態をそのまま渡す。**
          // 「繋がらなかった」と「切れた」の区別は、一度 connected になったかで決まる
          onState: (s) => {
            if (cancelled) return;
            if (s === "connected") everConnectedRef.current = true;
            // **判定は webrtc.ts の nextVoicePhase だけが行う。** ここでは呼ぶだけ
            const phase = nextVoicePhase(voicePhaseRef.current, s, everConnectedRef.current);
            voicePhaseRef.current = phase;
            setVoicePhase(phase);

            // つなぎ直しの最中は通話を畳まない（段階6）。
            // 経路の作り直しと期限の判定は webrtc.ts が行う。ここでは文言が変わるだけで、
            // マイクも離さないし、相手へ切る合図も送らない
            if (phase === "reconnecting") return;
            // 終わったと判定された場合だけ通話を畳む（副作用は状態の更新関数の外で呼ぶ）
            if (phase === "failed" || phase === "lost") endCallAfterFailure();
          },
          // 期限までに戻らなかった場合（段階6）
          onReconnectGiveUp,
          onRemoteStream: (stream) => {
            const a = audioRef.current;
            if (!a) return;
            a.srcObject = stream;
            void a.play().catch((e) => console.warn("[voice] 相手の声を鳴らせなかった", e));
          },
        });
        if (cancelled) { v.close(); return; }
        voiceRef.current = v;
        // マイクが使えているかを、通話が始まった時点で1回だけ調べる（段階5）。
        // 判定そのものは webrtc.ts が持っている（トラックが0本かどうか）
        setMicUnavailable(!v.micAvailable());
        const queued = pendingSignalsRef.current;
        pendingSignalsRef.current = [];
        for (const q of queued) await applySignal(q.kind, q.value);
      } catch (e) {
        // マイクが取れない・断られた。段階3では画面に出さず、記録だけ残す（段階5で扱う）
        console.warn("[voice] 通話を始められなかった（マイクの許可が下りなかった可能性）", e);
      }
    })();
    return () => { cancelled = true; };
  }, [call, send, closeVoice, applySignal, resetVoiceState, endCallAfterFailure, onReconnectGiveUp]);

  // 画面を離れるとき。**マイクを掴んだままにしない**。
  // 文言を消すための時計も片付ける（消えた画面に対して setState が走らないようにする）。
  //
  // ここが走るのは **別の画面へ移った場合だけ**（React が片付けを呼ぶため）。
  // タブを閉じた場合と再読み込みの場合は走らない。そちらは下の pagehide で扱う。
  //
  // 相手へ切る合図も送る（段階6）。送らないと、相手は段階6のつなぎ直しに入り、
  // 60秒待ってから通話を終えることになる。戻らないと分かっているなら待たせる必要はない
  useEffect(() => () => {
    const peer = callRef.current?.peerId;
    closeVoice();
    if (endTimerRef.current !== null) { clearTimeout(endTimerRef.current); endTimerRef.current = null; }
    if (peer != null) send({ type: "call.hangup", to: peer });
  }, [closeVoice, send]);

  // タブを閉じた場合と、ページを再読み込みした場合の後始末（段階6）。
  //
  // **React の片付けはこの2つでは走らない。** そのため別に構える。
  // 使うのは pagehide。beforeunload はブラウザによっては呼ばれず、
  // 戻る操作でページが保管される場合にも困る。
  //
  // **ここで送る合図は届かないことがある。** 閉じる途中で通信が切られるためで、
  // 届かなかった場合は相手側が60秒で通話を終える（段階6の期限）。
  // 届けば相手はすぐ終えられる。どちらでも破綻しない作りにしてある
  useEffect(() => {
    const onPageHide = () => {
      const peer = callRef.current?.peerId;
      if (peer == null) return;
      closeVoice();
      send({ type: "call.hangup", to: peer });
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [closeVoice, send]);

  // 呼びかけへの返事。
  //
  // **自分の他の端末にも知らせる（段階2-D）。**
  //   呼びかけは相手の全端末に届くため、1台で応答しても他の端末には呼びかけが出たままになる。
  //   ws-server は call.respond を「呼びかけた側」にしか返さないので、
  //   自分の他の接続へ配ってもらうために call.handled を別に送る。
  //   宛先は書かない（サーバーが接続から決めた自分の他の接続にだけ配る）
  const respondCall = useCallback((peerId: number, answer: "accept" | "later" | "decline") => {
    // 自分自身へは返事をしない（自分と通話している状態になるため）
    if (peerId === userRef.current.id) { setIncoming(null); return; }
    send({ type: "call.respond", to: peerId, answer });
    send({ type: "call.handled", answer });
    setIncoming(null);
    // 受けた側はここで通話に入る。呼びかけた側は call.answered を受けて入る
    if (answer === "accept") setCall({ peerId, role: "callee" });
  }, [send]);

  const callTo = (id: number, forced = false) => {
    const target = people.find((p) => Number(p.id) === id);
    const focus = (target?.talk ?? "ok") === "focus";
    if (focus && !forced) { setConfirmCall(id); return; }
    // 呼びかけた相手を覚える。返事が来たとき、この相手からのものかを確かめる
    invitedRef.current.add(id);
    send({ type: "call.invite", to: id, knewFocus: focus });
    setConfirmCall(null);
    setPicked(null);
  };

  return (
    <main className="min-h-screen" style={{ background: "var(--tk-paper)" }}>
      {/* ヘッダはアプリ名だけ。正常な接続は既定なので出さない。
          出し分け（段階7）:
            - 最初の接続まで: 「接続しています」を静かに出す（無言で待たせない）
            - 見るだけの人:   それ以上は出さない。**元々動かせないので、接続の有無は関係がない**
            - ログイン済み:   繋がらなくなったら赤く出す。動かせるはずのものが動かないため */}
      <header className="tk-head flex items-center gap-3 px-4 py-1.5">
        <h1 className="text-sm font-bold tracking-widest">tenko</h1>
        {conn !== "接続中" && !everConnected && (
          <span className="px-1.5 py-0.5 text-[10px] tk-soft" role="status">
            接続しています…
          </span>
        )}
        {conn !== "接続中" && everConnected && !isGuest && (
          <span
            className="border border-[var(--tk-ink)] px-2 py-0.5 text-[11px] font-bold text-white"
            style={{ background: "var(--tk-red)" }}
            role="status"
          >
            {conn === "切断" ? "切断されました" : "つなぎ直しています"}
            {stale && "（表示は切断前のものです）"}
          </span>
        )}
        {/* 在席の同期が止まったとき（段階7）。
            村が空に見えることと、同期が止まっていることを区別できるようにする。
            勤怠のアプリで村が空に見えると「誰も働いていない」という誤った主張になる */}
        {syncStopped && (
          <span
            className="border border-[var(--tk-ink)] px-2 py-0.5 text-[11px] font-bold"
            style={{ background: "var(--tk-straw)", color: "var(--tk-ink)" }}
            role="alert"
          >
            在席の同期が止まっています（村の人数は実際と違うかもしれません）
          </span>
        )}
        {/* 段階2までは「お試し版・ログインなし（誰にでもなりすませます）」を常時出していた。
            段階3で認証が入り、その表示は実態と食い違うようになったため差し替えた。
            いまは「見るだけかどうか」を出す。見るだけの人には、そう分かる形にする */}
        {isGuest ? (
          <span
            className="border border-[var(--tk-ink)] px-1.5 py-0.5 text-[10px]"
            style={{ background: "var(--tk-straw)", color: "var(--tk-ink)" }}
            title="ログインすると、自分のアバターが村に出ます"
          >
            見るだけ（ログインしていません）
          </span>
        ) : (
          <span className="px-1.5 py-0.5 text-[10px] tk-soft" title="ログインしています">
            {me.name}
          </span>
        )}
        {isGuest && (
          <Link href="/login" className="tk-btn px-2 py-0.5 text-[10px]">ログイン</Link>
        )}
        {/* セッションが切れたとき。黙って古い画面を映し続けない（段階3のチャットと同じ考え方）*/}
        {sessionLost && !isGuest && (
          <span
            className="border border-[var(--tk-ink)] px-1.5 py-0.5 text-[10px] font-bold text-white"
            style={{ background: "var(--tk-red)" }}
            role="alert"
          >
            ログインの期限が切れました
            <Link href="/login" className="ml-1 underline">入り直す</Link>
          </span>
        )}
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

      {/* 狭い画面での通話中（段階5）。
          サイドパネルは村と並べられる幅が無いと出さない作りだが、それだと
          通話に入った後に切ることもミュートすることもできなくなる。
          **通話中だけ**を村の上に横いっぱいで出す。
          いまの村・話しかけやすい人・部屋の空き・今月の勤怠は、狭い画面では出さないままにする */}
      {!showSidePanel && call && (
        <div className="px-3 pt-3">
          <SidePanel
            people={people}
            rooms={rooms}
            counts={counts}
            notes={notes}
            nameOf={nameOf}
            monthly={monthly}
            call={call}
            onHangUp={hangUp}
            muted={muted}
            onToggleMute={toggleMute}
            callStatus={voiceStatus}
            callEnded={callEnded}
            micUnavailable={micUnavailable}
            only="call"
          />
        </div>
      )}

      {/* 一覧を畳んでいるときは村を中央に置く。左に寄せると右が大きく空く（審査役B）*/}
      <div className={"flex items-start gap-3 p-3 " + (showRoster ? "" : "justify-center")}>
        {/* 全体を見るときはスクロールさせない。一覧性が村の価値なので、
            スクロールが出た時点で「全員がどこにいるか」が一目で分からなくなる */}
        <div className={"tk-panel bg-black " + (zoom === "close" ? "max-h-[calc(100vh-7rem)] overflow-auto" : "")}>
          <div ref={stageRef} className="relative" style={{ width: VILLAGE_W * SCALE, height: VILLAGE_H * SCALE }}>
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
                // 漂わせる対象なら、rAF ループが `translate` を書き込んでアバターに追従させる。
                // `transform` は既に使っているため、独立した CSS の `translate` を使う（上書きしない）
                data-drift-id={t.id}
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
                  // 名前と同じく、漂う人の吹き出しは同じ量だけずらす（置き去りにしない）
                  data-drift-id={b.userId}
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
                      {/* ログアウトの導線。
                          ヘッダではなくここに置いた。ヘッダは村の外の操作（接続の状態）を出す場所で、
                          自分に対する操作（状態を変える・退勤する）はすべてこのメニューに集めてあるため。
                          「退勤」の隣に置くことで、終わりの操作がひとまとまりになる */}
                      <button onClick={() => void doSignOut()} className={menuBtn}>ログアウト</button>
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
                    {/* デモ用の利用者には呼びかけない。
                        押せてしまうと「返事が来ない＝壊れている」に見える。
                        押す前に、返事をしない人であることを伝える（Phase 5 段階5）*/}
                    {pickedPerson?.demo && (
                      <p className="border border-[var(--tk-ink)] p-1.5 text-[11px] leading-4"
                         style={{ background: "var(--tk-paper-2)" }}>
                        この人は、村の様子を見せるために置いてあるデモの利用者です。
                        呼びかけても返事はしません。
                      </p>
                    )}
                    {isGuest && !pickedPerson?.demo && (
                      <p className="border border-[var(--tk-ink)] p-1.5 text-[11px] leading-4"
                         style={{ background: "var(--tk-paper-2)" }}>
                        呼びかけるにはログインが必要です。
                      </p>
                    )}
                    {pickedPerson && !pickedPerson.demo && !isGuest && confirmCall !== picked.id && (
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

        {/* 村だけでは数えられないことを補うパネル（作業: サイドパネル）。
            村の幅は変えていないので、余りが足りない画面では出さない */}
        {showSidePanel && (
          <SidePanel
            people={people}
            rooms={rooms}
            counts={counts}
            notes={notes}
            nameOf={nameOf}
            monthly={monthly}
            call={call}
            onHangUp={hangUp}
            muted={muted}
            onToggleMute={toggleMute}
            callStatus={voiceStatus}
            callEnded={callEnded}
            micUnavailable={micUnavailable}
          />
        )}

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

      {/* 相手の声（段階3）。見えるものは何も出さない。
          canvas からは音を出せないため、DOM にこの要素を1つ置く。
          srcObject を入れるのは webrtc.ts から受け取った時点だけで、
          通話していない間は空にしてある */}
      <audio ref={audioRef} autoPlay playsInline className="hidden" />

      {/* 画面下部。説明文は置かない（説明が要るUIは直す側）*/}
      <nav className="tk-head fixed inset-x-0 bottom-0 flex items-center gap-2 border-t px-4 py-1.5 text-xs">
        {autoAway && (
          <span className="border border-[var(--tk-ink)] px-2 py-0.5" style={{ background: "var(--tk-straw)" }}>
            {IDLE_MINUTES}分操作がないため離席にしました
          </span>
        )}
        {/* 通話中の表示はここには置かない。サイドパネルの一番上に移した。
            この帯は数秒で消える知らせの場所で、切るまで出し続けるものとは性質が違うため */}
        {callNotice && (
          <span className="border border-[var(--tk-ink)] px-2 py-0.5" style={{ background: "var(--tk-paper)" }} role="status">
            {callNotice}
          </span>
        )}
        {/* 通話中に受けられなかった呼びかけ。相手には伝わっていないため、こちらから折り返す */}
        {missed != null && (
          <span className="border border-[var(--tk-ink)] px-2 py-0.5" style={{ background: "var(--tk-paper)" }} role="status">
            通話中のため、{nameOf(missed)} からの呼びかけを受けませんでした
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
              {/* 未ログインには中身を出さない。押せることは分かるが、読めない */}
              {isGuest && (
                <li className="px-3 py-6 text-center text-xs" style={{ color: "var(--tk-ink-soft)" }}>
                  <p className="mb-2">村のお知らせは、ログインすると読めます。</p>
                  <Link href="/login" className="tk-btn px-3 py-1 text-xs">ログイン</Link>
                </li>
              )}
              {!isGuest && anns.length === 0 && (
                <li className="px-3 py-6 text-center text-xs" style={{ color: "var(--tk-ink-soft)" }}>
                  お知らせはまだありません
                </li>
              )}
              {!isGuest && anns.map((a) => (
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
              {/* 段階3で音が出るようになったため、段階2の文言（音はまだ出ません）を実体に合わせた */}
              「いま話せます」を押すと通話が始まります。マイクの使用許可を求める表示が出ます
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => respondCall(incoming.id, "accept")}
                className="tk-btn flex-1 justify-center"
              >
                いま話せます
              </button>
              <button
                onClick={() => respondCall(incoming.id, "later")}
                className="tk-btn tk-btn-quiet flex-1 justify-center"
              >
                あとで
              </button>
              <button
                onClick={() => respondCall(incoming.id, "decline")}
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
