// 「誰がこのリクエストを出したか」を決める唯一の場所。
//
// 認証は未実装であり、現状は利用者IDをリクエストのパラメータから受け取っている。
// これは「誰でも誰にでもなりすませる」状態である（S6）。
// 認証を入れるときは、この関数の中だけをセッションからの取得に差し替える。
// 呼び出し側は既に「actorId は信用できる値」という前提で書かれているため、他は変えなくてよい。
//
// TENKO_TRUST_USER_PARAM=0 を設定すると、リクエストの user を一切見ず、
// サーバー側の固定値だけを使う。認証を入れるまでの間、公開する場合は 0 にすること。
export const CURRENT_USER_ID = Number(process.env.TENKO_DEV_USER_ID ?? 1);
export const TRUST_USER_PARAM = (process.env.TENKO_TRUST_USER_PARAM ?? "1") === "1";

export function requestedUserId(raw: unknown): number {
  if (!TRUST_USER_PARAM) return CURRENT_USER_ID;
  const n = Number(raw ?? CURRENT_USER_ID);
  return Number.isInteger(n) && n > 0 ? n : -1;
}
