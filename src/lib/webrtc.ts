// 音声そのものを繋ぐ処理（段階3）。
//
// ここに置く理由:
//   画面（village-client.tsx）は既に1600行を超えている。接続の手順（offer / answer / 候補）を
//   そこへ直接書くと、村の描画・在席・呼びかけと混ざって追えなくなる。
//   このファイルは **DOM に触れない**。音を鳴らすのは画面側の仕事にしてある
//   （ここが返すのは MediaStream まで）。
//
// 設計方針（崩さないこと）:
//   - **音声は ws-server を通らない。** ブラウザ同士が直接やり取りする（P2P）。
//     ws-server が運ぶのは、繋ぐための情報（sdp と経路の候補）だけ
//   - **中身を作るのも解釈するのもブラウザ。** sdp を自分で組み立てたり書き換えたりしない
//   - どちらが先に接続情報（offer）を作るかは、ws-messages.ts の設計メモに従い
//     「**承認した側（callee）**」に固定する。両方が同時に作ると衝突する
//   - 段階3では STUN だけを使う。TURN は段階4。
//     したがって対称型NAT の内側にいる相手とは繋がらないことがある（調査で22%と実測報告あり）
//
// 段階5（繋がらなかったときの扱い）でここに手を入れる想定:
//   マイクが取れない・ICE が失敗した、を画面へ伝える経路はまだ作っていない。
//   いまは console に出すだけで、画面には出さない（CANON 段階3-C の指示）。

/**
 * STUN サーバー。無料で、登録もカード登録も要らないものを使う。
 *
 * Cloudflare の記述: "Cloudflare's STUN service at `stun.cloudflare.com` is free and unlimited."
 *   https://developers.cloudflare.com/realtime/turn/faq/
 * ポートは同社の一覧より 3478/udp。
 *   https://developers.cloudflare.com/realtime/turn/
 *
 * **TURN はここに書かない（段階4）。** 書くと資格情報を画面に埋めることになる。
 */
export const STUN_URLS = ["stun:stun.cloudflare.com:3478"];

/**
 * 通話が今どうなっているか（段階5）。**画面に出す文言はこれだけで決まる。**
 *
 * ここに置く理由:
 *   接続の状態（RTCPeerConnectionState）を持っているのはこのファイルである。
 *   画面側で判定を組むと、状態の出どころと判定が離れ、実体と表示がずれても気づけない。
 *
 *   connecting   : つないでいる最中（new / connecting）
 *   connected    : つながった
 *   reconnecting : connected になった後に disconnected になり、つなぎ直している最中（段階6）
 *   failed       : **一度も connected にならずに** failed になった
 *   lost         : 通話が終わった。**つなぎ直しに使える時間を過ぎた場合だけ。**
 *                  （段階6の改修より前は failed でもここへ来ていた。いまは failed も
 *                   つなぎ直しの対象なので、failed から直接ここへは来ない）
 */
export type VoicePhase = "connecting" | "connected" | "reconnecting" | "failed" | "lost";

/**
 * つなぎ直しに使える時間（ミリ秒）。**これを過ぎたら通話を終える。**
 *
 * 無期限に試み続けると、相手がタブを閉じた場合に通話中の表示が永久に残る。
 * 相手が戻ってこないことを、こちら側からは知る手立てが無いため、時間で打ち切る。
 * 60秒にした根拠は、電波の切り替わりや一時的な回線の途切れがこの範囲で戻るのに対し、
 * それを超える切断は「戻ってこない」ことのほうが多いという想定である（実測ではない）。
 */
export const RECONNECT_LIMIT_MS = 60_000;

/**
 * 作り直しを繰り返すときに、間にあける時間（ミリ秒）。段階6の改修。
 *
 * つなぎ直しの間、経路の作り直しは1回では済まないことがある。
 * 相手がまだ戻っていない時点で作り直しても、相手からの返事が来ないためである。
 * そこで期限（60秒）の間、繰り返し作り直す。
 *
 * 間隔を5秒にした根拠は、ICE の候補を集め直して相手と突き合わせるのに数秒かかり、
 * それより短い間隔で送ると、前の作り直しが終わる前に次の接続情報で上書きされるためである。
 */
export const RESTART_INTERVAL_MS = 5_000;

/**
 * 利用者IDが大きい側が、作り直しを始めるまでに待つ時間（ミリ秒）。段階6の改修。
 *
 * **両側が同時に接続情報を作ると衝突して、どちらも通らない。**
 * そこで先後を決める。決め方は「利用者IDの小さい側が先」で、
 * これは両側が自分と相手のIDを知っているため、相談なしに同じ答えになる。
 *
 * 大きい側が待つのは、小さい側が動けない場合（タブが固まった・処理が詰まった等）に
 * 誰も作り直さないまま期限を迎えることを避けるためである。
 * 3秒にした根拠は、作り直しが相手に届いて connected へ戻るまでに実測で1〜2秒かかり、
 * それを待ってなお戻っていなければ「小さい側は動いていない」と見なせるためである。
 */
export const RESTART_FOLLOWER_DELAY_MS = 3_000;

/**
 * 接続の状態が変わったときの、次の段階を返す。
 *
 * 「繋がらなかった」と「切れた」は、同じ failed から分かれる。
 * 分けるのは **一度でも connected になったか** だけなので、それを引数で受け取る。
 * 判定を1つの関数に閉じてあるので、外から同じ入力を与えれば同じ答えが確かめられる。
 *
 * 何も変えるべきでないときは prev をそのまま返す（closed など）。
 */
export function nextVoicePhase(
  prev: VoicePhase,
  state: RTCPeerConnectionState,
  everConnected: boolean,
): VoicePhase {
  // connected へ戻れば、つなぎ直しの最中であっても通話は続く
  if (state === "connected") return "connected";
  // **つなぎ直しの最中は connecting に落とさない。**
  //   ICE をやり直すと状態が connecting を経由することがあり、そこで文言が
  //   「つないでいます」に戻ると、初回の接続と区別が付かなくなる
  if (state === "new" || state === "connecting") {
    return prev === "reconnecting" ? "reconnecting" : "connecting";
  }
  // **failed もつなぎ直しの対象にする（段階6の改修）。**
  //
  //   以前はここで "lost" を返し、一度つながった後の failed で通話を終えていた。
  //   根拠として「ICE が尽きた状態で、同じ経路の作り直しでは戻らない」と書いていたが、
  //   **これは誤りだった。** 実測では、failed の後でも経路を作り直せば connected へ戻る。
  //   iceRestart は候補を集め直すため、尽きたのは「前回集めた候補」であって
  //   「集められる候補」ではない。
  //
  //   加えて、実測では disconnected から failed までが約10秒しかない。
  //   ここで打ち切ると、60秒の期限は一度も使われないまま通話が終わっていた。
  //
  // 通話を終えるのは、期限（RECONNECT_LIMIT_MS）を過ぎたときだけにする。
  // "lost" はその経路（onReconnectGiveUp）からのみ立つ
  if (state === "failed") return everConnected ? "reconnecting" : "failed";
  // 繋がる前の disconnected は途中の状態。まだ「切れた」とは言えない。
  // 一度繋がった後の disconnected は、つなぎ直しを試みる（段階6）
  if (state === "disconnected") return everConnected ? "reconnecting" : prev;
  return prev;
}

/** 段階ごとに画面へ出す文言。**文言を書くのはここ1か所だけにする。** */
export function voiceStatusText(phase: VoicePhase): string {
  if (phase === "connected") return "つながりました";
  if (phase === "reconnecting") return "つなぎ直しています";
  if (phase === "failed") return "相手とつながりませんでした";
  if (phase === "lost") return "通話が切れました";
  return "つないでいます";
}

// ── 送れなかった合図の控え（段階6の改修） ──────────────────────────────────
//
// ここに置く理由:
//   **判定は webrtc.ts に置き、画面は呼ぶだけにする。** このファイルが既に取っている形に揃える。
//   画面側に条件を書くと、控える対象が通話の都合ではなく画面の都合で決まるようになり、
//   対象が広がったことに気づけなくなる。ここに置けば Node からそのまま駆動して確かめられる。

/**
 * 送れなかったときに控える合図の種別。
 *
 * **つなぎ直しに関わる3種だけを対象にする。ここを広げないこと。**
 * 在席や呼びかけを控えて後から送ると、実体とずれた主張が遅れて届くことになる
 * （既に離席した人を在席として送り直すなど）。
 * 合図は相手のブラウザが解釈するもので、古ければ相手側が捨てる
 */
export const HELD_SIGNAL_TYPES = ["call.offer", "call.answer", "call.candidate"] as const;

/** 控える対象の合図か。**対象を絞っているのはここ1か所だけ** */
export function isHeldSignal(obj: unknown): boolean {
  const type = (obj as { type?: unknown } | null | undefined)?.type;
  return typeof type === "string" && (HELD_SIGNAL_TYPES as readonly string[]).includes(type);
}

/**
 * 送れなかった合図の控え。**最新の1件だけを持つ。溜め込まない。**
 *
 * 作り直しは期限まで繰り返し行われるため、溜めると繋がり直した瞬間に
 * 古い接続情報が何通も飛び、最後に届いたものが勝つ。それなら最初から最新の1件でよい
 */
export type HeldSignal = { held: unknown };
export function createHeldSignal(): HeldSignal { return { held: null }; }

/** 送り先の最小の形。WebSocket でも、試験の偽物でもこれを満たす */
type SocketLike = { readyState: number; send(data: string): void };
/** WebSocket.OPEN の値。定数を持ち込まずに済ませるため、ここに書く */
const WS_OPEN = 1;

/**
 * 合図を送る。送れなければ、対象のものだけを控える。
 *
 * **閉じている間の送信は、これまで黙って捨てられていた。**
 *   つなぎ直しは「作り直した接続情報を相手へ届ける」ことで成り立つ。
 *   ところが回線が切れているときは、音声の経路と WebSocket の両方が同時に落ちる。
 *   そのため作り直しの接続情報がまさに捨てられ、相手には何も届かず、
 *   60秒の期限を待って通話が終わっていた。
 *
 * 戻り値は「いま送れたか」。控えたかどうかではない
 */
export function sendOrHold(socket: SocketLike | null, obj: unknown, held: HeldSignal): boolean {
  if (!socket || socket.readyState !== WS_OPEN) {
    if (isHeldSignal(obj)) {
      held.held = obj;
      console.log("[voice] 送れなかった合図を控えた: " + (obj as { type: string }).type);
    }
    return false;
  }
  socket.send(JSON.stringify(obj));
  return true;
}

/**
 * 繋がり直したときに、控えてある合図を送り直す。
 *
 * **通話が終わっていれば送り直さない**（inCall で渡す）。
 * 終わった通話の接続情報が届くと、相手が別の通話を始めていた場合にそれを壊しうる。
 * 控えは、送っても送らなくてもここで必ず消す（次の切断まで持ち越さない）。
 *
 * 戻り値は「送り直したか」
 */
export function resendHeld(socket: SocketLike | null, held: HeldSignal, inCall: boolean): boolean {
  const obj = held.held;
  held.held = null;
  if (obj === null || obj === undefined) return false;
  if (!inCall) { console.log("[voice] 控えていた合図を捨てた（通話が終わっている）"); return false; }
  if (!socket || socket.readyState !== WS_OPEN) return false;
  socket.send(JSON.stringify(obj));
  console.log("[voice] 控えていた合図を送り直した: " + (obj as { type: string }).type);
  return true;
}
// ── 控えはここまで ───────────────────────────────────────────────────────

/** 相手へ送る合図。中身は運ぶだけで、ws-server も解釈しない（段階1） */
export type SignalSender = (msg:
  | { type: "call.offer"; to: number; sdp: string }
  | { type: "call.answer"; to: number; sdp: string }
  | { type: "call.candidate"; to: number; candidate: unknown }
) => void;

export type VoiceCall = {
  peerId: number;
  /** 相手からの接続情報を受けた（呼びかけた側で起きる） */
  handleOffer(sdp: string): Promise<void>;
  /** 返事の接続情報を受けた（承認した側で起きる） */
  handleAnswer(sdp: string): Promise<void>;
  /** 追加の経路の候補を受けた */
  addCandidate(candidate: unknown): Promise<void>;
  /**
   * 自分の音声の送信を一時的に止める / 戻す。
   *
   * **止めるのは enabled であって stop ではない。**
   * stop を呼ぶとトラックが終わり、戻すときにマイクを取り直すことになる
   * （許可を求め直す形になり、通話中に断られると復帰できない）。
   * enabled = false の間は無音が送られる。
   * ブラウザのタブのマイクの印は出たままになる（掴んだままであるため。これは仕様）。
   */
  setMuted(muted: boolean): void;
  /** いまミュートしているか */
  isMuted(): boolean;
  /** 通話を終える。**マイクを必ず止める**（止めないとタブの印が残り続ける） */
  close(): void;
  /** いまマイクを掴んでいるか（試験と自己点検のために外から見えるようにしておく） */
  micActive(): boolean;
  /**
   * マイクが使えているか（段階5）。
   *
   * **偽でも通話は成立する。** 相手の声は聞こえ、こちらの声だけが届かない。
   * 偽になるのは、マイクの取得が拒否された場合と、取れた音声トラックが0本の場合。
   * この2つを分けない理由は、利用者から見ればどちらも「声が届かない」であり、
   * 対処（許可し直して入り直す）も同じだからである。
   */
  micAvailable(): boolean;
  /**
   * つなぎ直しを試みる（段階6）。**通話は終えない。マイクも離さない。**
   *
   * 呼びかけからやり直さない。いま繋がっている RTCPeerConnection をそのまま使い、
   * 経路の選び直し（ICE のやり直し）だけを行う。相手には既にある call.offer で届くため、
   * ws-server に新しい種別を足す必要はない。
   *
   * **どちらの側からでも作り直せる（段階6の改修）。**
   *   改修より前は承認した側（callee）だけが作り直していたため、
   *   承認した側が動けない場合、呼びかけた側は自力で復帰する手段を持たなかった。
   *   実測では、呼びかけた側からの作り直しでも復帰する。
   *   衝突は、向きを固定するのではなく **利用者IDによる先後** で避ける
   *   （RESTART_FOLLOWER_DELAY_MS を参照）。
   *
   * 戻り値は「自分から作り直しを送ったか」であり、繋がり直せたかではない。
   * 繋がり直せたかは connectionState が connected へ戻るかで判る
   */
  restart(): Promise<boolean>;
  /** いまつなぎ直しの最中か（段階6）。試験と自己点検のために外から見えるようにしておく */
  isReconnecting(): boolean;
};

/**
 * 通話を始める。**この関数の中でしかマイクを取らない。**
 * 呼ぶのは、通話の状態が立った瞬間だけ（village-client.tsx）。
 *
 * 許可が下りなければ例外を投げる。段階3では呼んだ側が握りつぶしてログに出す。
 */
export async function startVoice(opts: {
  peerId: number;
  /**
   * 自分の利用者ID（段階6の改修）。
   *
   * つなぎ直しで、どちらが先に接続情報を作り直すかを決めるためだけに使う。
   * 相談せずに両側が同じ答えを出せる必要があるため、両側が知っている値で決める。
   * 自分のIDと相手のIDは、どちらの側でも既に分かっている
   */
  selfId: number;
  role: "caller" | "callee";
  send: SignalSender;
  onRemoteStream: (stream: MediaStream) => void;
  onState?: (state: RTCPeerConnectionState) => void;
  /**
   * 中継サーバー（TURN）の設定（段階4）。
   * 使い捨ての合言葉つきで /api/turn-credentials から受け取ったものを、そのまま渡す。
   * **渡されなければ段階3と同じく STUN だけで動く。** 中継が使えないことは、
   * 通話を始められないことではない（直接つながる相手とは繋がる）
   */
  iceServers?: RTCIceServer[];
  /**
   * つなぎ直しに使える時間を過ぎたときに呼ばれる（段階6）。
   * ここで通話を終える。**呼ばれるのは1回だけ。**
   */
  onReconnectGiveUp?: () => void;
  /**
   * つなぎ直しの期限。**既定は RECONNECT_LIMIT_MS。試験でだけ短くする。**
   * 60秒を実際に待つ試験は、待っている間に何も確かめられない
   */
  reconnectLimitMs?: number;
  /**
   * 作り直しを繰り返す間隔。**既定は RESTART_INTERVAL_MS。試験でだけ短くする。**
   */
  restartIntervalMs?: number;
  /**
   * 利用者IDが大きい側が待つ時間。**既定は RESTART_FOLLOWER_DELAY_MS。試験でだけ短くする。**
   */
  followerDelayMs?: number;
  /**
   * 時計。**試験で差し替えるためだけにある。** 既定はブラウザの setTimeout。
   * 差し替えられるようにしてあるのは、期限の判定を実際に60秒待たずに確かめるため
   */
  timers?: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  };
}): Promise<VoiceCall> {
  const { peerId, selfId, role, send, onRemoteStream, onState, onReconnectGiveUp } = opts;
  const reconnectLimitMs = opts.reconnectLimitMs ?? RECONNECT_LIMIT_MS;
  const restartIntervalMs = opts.restartIntervalMs ?? RESTART_INTERVAL_MS;
  const followerDelayMs = opts.followerDelayMs ?? RESTART_FOLLOWER_DELAY_MS;
  const timers = opts.timers ?? {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };

  // 音声だけ。映像は取らない（取ると許可の求め方が変わり、通信量も跳ね上がる）。
  //
  // **許可が下りなくても通話は始める（段階5）。**
  //   以前はここで例外が出て、通話そのものが始まらなかった。
  //   だが「自分の声が届かない」ことと「相手の声も聞こえない」ことは別である。
  //   マイクを断った人にも、相手の声は聞こえてよい（聞くだけの参加ができる）。
  //   声が届いていないことは画面に出す（micAvailable を見て画面側が出す）。
  let local: MediaStream;
  try {
    local = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    // 断られた・マイクが無い・別のアプリが掴んでいる。**通話は続ける**
    console.warn("[voice] マイクを取れなかった（相手の声は聞こえるが、こちらの声は届かない）", e);
    local = new MediaStream();
  }

  // マイクが使えたかを、**通話を始めた時点で控える**（段階6）。
  // 品質の記録に出すために使う。閉じるときに数え直すと、その時点では
  // トラックを外した後なので、常に「使えなかった」になってしまう
  const micWasAvailable = local.getAudioTracks().length > 0;

  // STUN は必ず入れる。中継の設定は、あれば後ろに足す。
  // **STUN_URLS の値は変えない**（段階3で確かめた、無料・無登録のもの）
  const iceServers: RTCIceServer[] = [{ urls: STUN_URLS }, ...(opts.iceServers ?? [])];
  console.log("[voice] 中継サーバーの設定: " + ((opts.iceServers?.length ?? 0) > 0 ? "あり" : "無し（STUNのみ）"));

  const pc = new RTCPeerConnection({ iceServers });
  for (const track of local.getTracks()) pc.addTrack(track, local);
  // 送るものが1つも無い場合、そのままでは音声の枠が作られず、相手の声も受け取れない。
  // 受け取る専用の枠を明示して作る
  if (local.getAudioTracks().length === 0) {
    pc.addTransceiver("audio", { direction: "recvonly" });
  }

  // ── ここから、切り分けのための記録（段階5の調査） ────────────────────────
  //
  // 音が歪むのは実マイクと実スピーカーを通したときだけで、手元では再現しない。
  // そこで「どの経路で繋がったか」「どれだけ落ちて・揺れて・埋められたか」を
  // 記録に出し、POが実機で読めるようにする。**画面には出さない**（出し方は段階5で決める）。
  //
  // **候補が集まったことを根拠にしない。** 実際に使われている組を統計から引く。
  // 候補はいくつも集まるが、使われるのはそのうち1組だけである。

  /** 実際に使われている候補の組を、統計から1つ引く。無ければ null */
  const selectedPair = (s: RTCStatsReport) => {
    const byId = new Map<string, RTCStats>();
    s.forEach((r) => byId.set(r.id, r));

    // transport が指している組が正。ここに無い場合だけ、succeeded かつ nominated を拾う
    let pair: (RTCStats & Record<string, unknown>) | null = null;
    s.forEach((r) => {
      const t = r as RTCStats & { selectedCandidatePairId?: string };
      if (r.type === "transport" && t.selectedCandidatePairId) {
        pair = (byId.get(t.selectedCandidatePairId) as typeof pair) ?? pair;
      }
    });
    if (!pair) {
      s.forEach((r) => {
        const c = r as RTCStats & { selected?: boolean; nominated?: boolean; state?: string };
        if (r.type === "candidate-pair" && (c.selected || (c.nominated && c.state === "succeeded"))) {
          pair = r as typeof pair;
        }
      });
    }
    if (!pair) return null;

    const p = pair as RTCStats & { localCandidateId?: string; remoteCandidateId?: string; currentRoundTripTime?: number };
    const lc = p.localCandidateId ? (byId.get(p.localCandidateId) as { candidateType?: string } | undefined) : undefined;
    const rc = p.remoteCandidateId ? (byId.get(p.remoteCandidateId) as { candidateType?: string } | undefined) : undefined;
    return {
      localType: lc?.candidateType ?? "不明",
      remoteType: rc?.candidateType ?? "不明",
      rtt: typeof p.currentRoundTripTime === "number" ? p.currentRoundTripTime : null,
    };
  };

  let routeLogged = false;
  /** 最後に読めた品質の1行。閉じるときに出す（閉じた後は統計を読めないため先に貯めておく） */
  let lastQuality: string | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;

  const ms = (sec: number | null | undefined) =>
    typeof sec === "number" ? (sec * 1000).toFixed(1) + "ms" : "不明";
  const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toFixed(2) + "%" : "—");

  const readStats = async () => {
    if (closed) return;
    let s: RTCStatsReport;
    try { s = await pc.getStats(); } catch { return; }

    // 経路は繋がった直後に1回だけ出す。毎秒出すと記録が埋まる
    const sel = selectedPair(s);
    if (!routeLogged && sel) {
      routeLogged = true;
      console.log("[voice] 経路: " + sel.localType + " / " + sel.remoteType);
    }

    // 品質は貯め続け、閉じるときに最後の1行を出す
    let packetsSent = 0, packetsReceived = 0, packetsLost = 0;
    let jitter: number | null = null, concealed = 0, samples = 0;
    s.forEach((r) => {
      const a = r as RTCStats & Record<string, number | string | undefined>;
      if (r.type === "outbound-rtp" && a.kind === "audio") {
        packetsSent = Number(a.packetsSent ?? 0);
      }
      if (r.type === "inbound-rtp" && a.kind === "audio") {
        packetsReceived = Number(a.packetsReceived ?? 0);
        packetsLost = Number(a.packetsLost ?? 0);
        jitter = typeof a.jitter === "number" ? a.jitter : jitter;
        concealed = Number(a.concealedSamples ?? 0);
        samples = Number(a.totalSamplesReceived ?? 0);
      }
    });
    // 届くはずだった数 = 受け取った数 + 失われた数
    const expected = packetsReceived + packetsLost;
    lastQuality =
      "[voice] 品質: 受信で失われた小包 " + packetsLost + "/" + expected + "（" + pct(packetsLost, expected) + "）" +
      " / 送った小包 " + packetsSent +
      " / 揺らぎ " + ms(jitter) +
      " / 往復 " + ms(sel?.rtt) +
      " / 埋めた標本 " + concealed + "（" + pct(concealed, samples) + "）" +
      // マイクを拒否した通話では、埋めた標本が高い値になる（送るものが無いため）。
      // 記録だけを見て「回線が悪い」と読み違えないよう、可否を並べて出す（段階6）
      " / マイク " + (micWasAvailable ? "使えた" : "使えなかった");
  };

  // 2秒ごとに読む。閉じる直前の値を持っておくため
  poller = setInterval(() => { void readStats(); }, 2_000);
  // ── 記録のための追加はここまで ───────────────────────────────────────

  // 相手の接続情報が入る前に届いた候補は、ここに溜めてから入れる。
  // 先に入れると InvalidStateError になり、その候補は捨てられる（経路が1つ減る）
  const pending: RTCIceCandidateInit[] = [];
  let remoteSet = false;
  let closed = false;

  // ── つなぎ直し（段階6） ──────────────────────────────────────────────
  //
  // ここに置く理由:
  //   接続の状態を受け取っているのはこのファイルであり、期限の判定もここに置くと
  //   状態と判定が同じ場所に揃う。画面側に置くと、実際の接続と画面の都合が混ざる。
  //   時計を差し替えられるようにしてあるので、60秒を待たずに確かめられる。
  //
  // **一度でも connected になっていなければ、つなぎ直さない。**
  //   まだ繋がったことのない接続の disconnected は、繋がる途中の状態にすぎない。
  let everConnected = false;
  let reconnecting = false;
  let gaveUp = false;
  let limitTimer: unknown = null;
  let restartTimer: unknown = null;

  const clearLimit = () => {
    if (limitTimer !== null) { timers.clear(limitTimer); limitTimer = null; }
  };
  const clearRestartTimer = () => {
    if (restartTimer !== null) { timers.clear(restartTimer); restartTimer = null; }
  };

  /**
   * つなぎ直しで、自分が先に作り直す側か（段階6の改修）。
   *
   * **ここが先後を決めている唯一の場所。** 利用者IDの小さい側が先に作り直し、
   * 大きい側は followerDelayMs だけ待つ。両側が同じ2つのIDを見て決めるため、
   * 相談なしに必ず食い違わない答えになる
   */
  const restartsFirst = selfId < peerId;

  /** 経路を作り直す。**どちらの側からでも送れる**（先後で衝突を避ける） */
  const doRestart = async (): Promise<boolean> => {
    if (closed) return false;
    try {
      // iceRestart で経路の候補を集め直す。**トラックは差し替えない**ので、
      // マイクは掴んだままになる（つなぎ直しの間も離さない）
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      send({ type: "call.offer", to: peerId, sdp: offer.sdp ?? "" });
      console.log("[voice] つなぎ直し: 経路を作り直して送った（自分=" + selfId + " 相手=" + peerId + " 順序=" + (restartsFirst ? "先" : "後") + "）");
      return true;
    } catch (e) {
      // 作り直せなくても通話は畳まない。期限の判定に任せる
      console.warn("[voice] つなぎ直し: 作り直せなかった", e);
      return false;
    }
  };

  /**
   * 次の作り直しを予約する（段階6の改修）。
   *
   * **connected へ戻っていれば作り直さない。** 予約が残っていても、
   * 発火した時点で状態を見て降りる。つなぎ直しが終わった後に
   * 作り直しの接続情報を送ると、繋がっている通話を壊すことになる
   */
  const scheduleRestart = (delayMs: number) => {
    clearRestartTimer();
    restartTimer = timers.set(() => {
      restartTimer = null;
      if (closed || !reconnecting || gaveUp) return;
      if (pc.connectionState === "connected") return;
      void doRestart();
      // 期限を過ぎるまで繰り返す。打ち切るのは limitTimer の仕事
      scheduleRestart(restartIntervalMs);
    }, delayMs);
  };

  const beginReconnect = () => {
    // **既に始まっていれば何もしない。** disconnected は繋がらない間ずっと届くため、
    // そのたびに数え直すと期限が後ろへずれ、いつまでも打ち切られなくなる。
    // failed もここへ来るようになったため（段階6の改修）、この見張りがないと
    // disconnected → failed の2回で期限が二重に立つ
    if (closed || reconnecting || gaveUp) return;
    reconnecting = true;
    console.log("[voice] つなぎ直しを始める（" + Math.round(reconnectLimitMs / 1000) + "秒まで待つ / 作り直しの順序: " +
      (restartsFirst ? "先" : "後（" + followerDelayMs + "ms 待つ）") + "）");
    // 小さいIDの側はすぐ作り直す。大きいIDの側は待ち、
    // その時点でまだ connected へ戻っていなければ作り直す
    if (restartsFirst) {
      void doRestart();
      scheduleRestart(restartIntervalMs);
    } else {
      scheduleRestart(followerDelayMs);
    }
    limitTimer = timers.set(() => {
      limitTimer = null;
      if (closed || !reconnecting) return;
      reconnecting = false;
      gaveUp = true;
      // 期限を過ぎたので、以後の作り直しも止める
      clearRestartTimer();
      console.log("[voice] つなぎ直しの期限を過ぎた。通話を終える");
      onReconnectGiveUp?.();
    }, reconnectLimitMs);
  };

  const endReconnect = () => {
    // connected へ戻った時点で、予約してある作り直しも取り消す（段階6の改修）。
    // 残しておくと、繋がった後に作り直しの接続情報が飛んで通話を壊す
    clearRestartTimer();
    if (!reconnecting) { clearLimit(); return; }
    reconnecting = false;
    clearLimit();
    console.log("[voice] つなぎ直しに成功した");
  };
  // ── つなぎ直しはここまで ─────────────────────────────────────────────

  const drain = async () => {
    while (pending.length > 0) {
      const c = pending.shift()!;
      try { await pc.addIceCandidate(c); } catch (e) { console.warn("[voice] 候補を入れられなかった", e); }
    }
  };

  pc.onicecandidate = (e) => {
    if (closed || !e.candidate) return;
    // toJSON で素の値にしてから送る。クラスのまま JSON にすると中身が落ちる
    send({ type: "call.candidate", to: peerId, candidate: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    if (closed) return;
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    onRemoteStream(stream);
  };
  pc.onconnectionstatechange = () => {
    console.log("[voice] 接続の状態: " + pc.connectionState);
    const s = pc.connectionState;
    // 繋がった時点で経路を出す。2秒の間隔を待たずに読む
    if (s === "connected") { everConnected = true; void readStats(); }

    // つなぎ直しの出入り（段階6）。**画面へ伝える前に決める。**
    //   connected へ戻れば、つなぎ直しは終わり（通話は続く）
    //   一度繋がった後の disconnected なら、つなぎ直しを始める
    //   **一度繋がった後の failed も同じ扱いにする（段階6の改修）。**
    //     改修より前は、ここで reconnecting を降ろし期限も消していた。
    //     実測では disconnected から failed までが約10秒しかなく、
    //     そのため60秒の期限は一度も使われずに通話が終わっていた。
    //     failed でも経路を作り直せば復帰することは実測で確かめてある。
    //     beginReconnect は二重に始まらない作りなので、
    //     disconnected の後に failed が来ても期限は数え直されない（数え続ける）
    if (s === "connected") endReconnect();
    else if ((s === "disconnected" || s === "failed") && everConnected) beginReconnect();

    onState?.(s);
  };

  // **承認した側が先に接続情報を作る**（ws-messages.ts の設計メモ 2 のとおり）。
  // 呼びかけた側は待つだけでよく、両方が同時に作って衝突することも無い
  if (role === "callee") {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: "call.offer", to: peerId, sdp: offer.sdp ?? "" });
  }

  return {
    peerId,
    async handleOffer(sdp: string) {
      if (closed) return;
      await pc.setRemoteDescription({ type: "offer", sdp });
      remoteSet = true;
      await drain();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "call.answer", to: peerId, sdp: answer.sdp ?? "" });
    },
    async handleAnswer(sdp: string) {
      if (closed) return;
      await pc.setRemoteDescription({ type: "answer", sdp });
      remoteSet = true;
      await drain();
    },
    async addCandidate(candidate: unknown) {
      if (closed || !candidate) return;
      const c = candidate as RTCIceCandidateInit;
      if (!remoteSet) { pending.push(c); return; }
      try { await pc.addIceCandidate(c); } catch (e) { console.warn("[voice] 候補を入れられなかった", e); }
    },
    restart() { return doRestart(); },
    isReconnecting() { return reconnecting; },
    setMuted(muted: boolean) {
      if (closed) return;
      // 画面側からトラックを直接触らせない。ここ1か所で切り替える
      for (const track of local.getAudioTracks()) track.enabled = !muted;
      console.log("[voice] ミュート: " + (muted ? "する" : "解除"));
    },
    isMuted() {
      const tracks = local.getAudioTracks();
      return tracks.length > 0 && tracks.every((t) => !t.enabled);
    },
    close() {
      if (closed) return;
      // **品質の記録を、閉じる前に出す。** 閉じた後は統計を読めない。
      // closed を立てる前に出すのは、readStats が closed を見て何もしなくなるため
      if (lastQuality) console.log(lastQuality);
      else console.log("[voice] 品質: 記録なし（繋がる前に終わった） / マイク " + (micWasAvailable ? "使えた" : "使えなかった"));
      if (poller !== null) { clearInterval(poller); poller = null; }
      // つなぎ直しの時計も止める（段階6）。残すと、閉じた通話に対して期限が鳴る
      reconnecting = false;
      clearLimit();
      clearRestartTimer();

      closed = true;
      // **マイクを先に止める。** 後回しにすると、閉じる途中で失敗したときに掴んだままになる。
      // 止めたトラックはストリームからも外す（段階6）。
      // 止めるだけだと readyState が ended のまま残り続け、通話のたびに1本ずつ増える。
      // 増えた分は誰も使わないが、本数を見て判断する処理（micActive・micAvailable）が
      // 「ある」と答えてしまうため、数えられる状態から外しておく
      for (const track of local.getTracks()) {
        track.stop();
        local.removeTrack(track);
      }
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try { pc.close(); } catch { /* 既に閉じている */ }
      console.log("[voice] 通話を終えた（マイクを止めた）");
    },
    micActive() {
      return local.getTracks().some((t) => t.readyState === "live");
    },
    micAvailable() {
      // 取れた音声トラックが0本なら使えていない。
      // 取得が拒否された場合も、上で空の MediaStream にしてあるので0本になる
      return local.getAudioTracks().length > 0;
    },
  };
}
