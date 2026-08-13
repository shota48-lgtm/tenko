// デモ用の利用者を、広場の中だけで漂わせる（見た目だけ）。
//
// なぜクライアント側でやるか:
//   - ws-server は DB を持たない（事前調査 Q9）。座標の保存先が無い
//   - WS の入場券は認証必須。未ログインの閲覧者に配信が届くとは限らない
//   → **サーバーの状態は1バイトも変えない。** 動いて見えるのは描画だけにする。
//
// **決定的**であること:
//   同じ id と同じ時刻を入れたら、どのブラウザでも同じ座標が出る。
//   したがって乱数は使わない（`Math.random()` は1回も呼ばない）。
//   時刻は `Date.now()`。閲覧者ごとに時計が数秒ずれても、見た目に影響しない。
//
// 動かす対象:
//   `demo === true` かつ `roomId == null` の人だけ。
//   会議中（建物の中）の人が歩き回るのは嘘になるため、動かさない。
//   実在の利用者は**一切動かさない**（サーバーが決めた座標が正）。
import { buildingForAvatar, clampToVillage, hitFountain, PERSON_SIZE, type Presence, type Room } from "@/village/render";

/** 揺れの周期。X と Y を互いに素に近い値にして、軌道が閉じない（同じ往復に見えない）ようにする */
export const DRIFT_PERIOD_X_MS = 24_000;
export const DRIFT_PERIOD_Y_MS = 31_000;

/** 振幅。アバターは32px なので、40px 動けば体1.25個分で目視に十分 */
export const DRIFT_MAX = 40;
/** これを下回るなら動かさない。中途半端な震えはノイズにしかならない */
export const DRIFT_MIN = 8;
export const DRIFT_STEP = 4;

const TAU = Math.PI * 2;
/** 黄金角。id が連番でも位相が偏らない */
const GOLDEN_X = 2.39996;
const GOLDEN_Y = 4.79992;

export function phaseX(id: number): number { return (id * GOLDEN_X) % TAU; }
export function phaseY(id: number): number { return (id * GOLDEN_Y) % TAU; }

/** 拠点（サーバーが決めた座標）と、その人が動いてよい幅 */
export type DriftPlan = Map<number, { anchorX: number; anchorY: number; amp: number }>;

/**
 * その拠点から ±amp の正方形が、建物にも噴水にも一切かからないか。
 *
 * **判定は既存の関数を使う。** 同じ判定を書き起こすと、片方だけ直したときに食い違う
 * （建物の判定は矩形の外側 ENTER_MARGIN=12px まで及ぶ）。
 *   - 建物: `buildingForAvatar(rooms, x, y)` … 引数はアバターの左上。内部で中心に直す
 *   - 噴水: `hitFountain(x, y)` … 引数は「点」なので、**中心を渡す**
 *     （ws-server の onFountain も中心で見ている。左上を渡すと判定がずれる）
 *   - 村の内側: `clampToVillage(x, y)` が値を動かさないこと
 *
 * **村の内側の条件は CANON の 6-2 に無いが、足した。**
 * 建物と噴水だけで判定したところ、30秒 x 14人 = 25,200 フレームのうち **2,435 回**が
 * 村の外にはみ出した（端にいる id=10/14/17/18/20。実測）。外に出た人は
 * `clampToVillage` で端に貼り付き、そこだけ動きが止まって不自然に見える。
 * 「広場の中だけで動かす」という目的に反するため、安全条件に含めた。
 */
function squareIsClear(rooms: Room[], cx: number, cy: number, amp: number): boolean {
  // 四隅・各辺の中点・中心の9点
  const offsets: [number, number][] = [
    [-amp, -amp], [0, -amp], [amp, -amp],
    [-amp, 0], [0, 0], [amp, 0],
    [-amp, amp], [0, amp], [amp, amp],
  ];
  const half = PERSON_SIZE / 2;
  for (const [dx, dy] of offsets) {
    const x = cx + dx;
    const y = cy + dy;
    if (buildingForAvatar(rooms, x, y)) return false;
    if (hitFountain(x + half, y + half)) return false;
    const inside = clampToVillage(x, y);
    if (inside.x !== x || inside.y !== y) return false;
  }
  return true;
}

/**
 * 安全な振幅を求める。40 から 4 ずつ下げ、8 を下回ったら 0（動かさない）。
 * 拠点ごとに1回だけ計算し、以後は使い回す（毎フレーム計算しない）。
 */
export function safeAmplitude(rooms: Room[], anchorX: number, anchorY: number): number {
  for (let a = DRIFT_MAX; a >= DRIFT_MIN; a -= DRIFT_STEP) {
    if (squareIsClear(rooms, anchorX, anchorY, a)) return a;
  }
  return 0;
}

/**
 * 動かす対象を選び、拠点と安全振幅を決める。
 * `people` が更新されたときだけ呼ぶ（毎フレーム呼ばない）。
 */
export function buildDriftPlan(rooms: Room[], people: Presence[]): DriftPlan {
  const plan: DriftPlan = new Map();
  for (const p of people) {
    // デモ用で、かつ建物の中にいない人だけ
    if (p.demo !== true) continue;
    if (p.roomId != null) continue;
    if (p.x == null || p.y == null) continue;
    const amp = safeAmplitude(rooms, p.x, p.y);
    if (amp <= 0) continue;   // 動かせる幅が無い人は対象から外す
    plan.set(Number(p.id), { anchorX: p.x, anchorY: p.y, amp });
  }
  return plan;
}

/** その時刻での、拠点からのずれ。整数に丸める（座標は integer に揃える） */
export function driftOffset(id: number, amp: number, t: number): { dx: number; dy: number } {
  return {
    dx: Math.round(amp * Math.sin(TAU * t / DRIFT_PERIOD_X_MS + phaseX(id))),
    dy: Math.round(amp * Math.sin(TAU * t / DRIFT_PERIOD_Y_MS + phaseY(id))),
  };
}

/**
 * 描画用に、対象者の x, y だけ差し替えた**複製**を返す。
 * **元の配列・要素は書き換えない。** サーバー由来の値を汚すと、
 * 呼びかけ・定員・ドラッグの判定が壊れる。
 */
export function applyDrift(people: Presence[], plan: DriftPlan, t: number): Presence[] {
  if (plan.size === 0) return people;
  return people.map((p) => {
    const d = plan.get(Number(p.id));
    if (!d) return p;
    const { dx, dy } = driftOffset(Number(p.id), d.amp, t);
    return { ...p, x: d.anchorX + dx, y: d.anchorY + dy };
  });
}

/** 画面の重ね物（名前・吹き出し）を同じ量だけずらすために使う */
export function driftOffsetsAt(plan: DriftPlan, t: number): Map<number, { dx: number; dy: number }> {
  const out = new Map<number, { dx: number; dy: number }>();
  for (const [id, d] of plan) out.set(id, driftOffset(id, d.amp, t));
  return out;
}
