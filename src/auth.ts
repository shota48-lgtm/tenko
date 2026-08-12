// 認証。「この人は誰か」だけをここで決める。
//
// 方針（docs/PHASE5_AUTH_DESIGN.md）:
//   - Google 認証のみ。パスワードは1文字も扱わない
//   - 権限（role / manager_id）は既存の users が持つ。認証の提供元にも Auth.js にも持たせない。
//     Google が答えるのは「この人は誰か」だけである
//   - セッションはDB方式。JWT にしない。退職者・不正利用者を即座に締め出せることを優先する
//   - 事前に users に登録されたメールアドレスの人だけが中に入れる。判定は signIn で行う
//
// 認証を外部に乗り換えることになった場合、直すのはこのファイルと src/lib/actor.ts だけで済むようにしてある。
import NextAuth, { type Session } from "next-auth";
import Google from "next-auth/providers/google";
import PostgresAdapter from "@auth/pg-adapter";
import { pool } from "@/lib/db";

// 最初の管理者。カンマ区切りで複数書ける。
// ここに書いただけでは利用者は増えない。users に行があることが前提（下の signIn の順序）
const ADMIN_EMAILS = (process.env.TENKO_ADMIN_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s.length > 0);

export type TenkoUser = { id: number; displayName: string; role: string };

// メールアドレスから、tenko の利用者を引く。
// 大文字小文字は区別しない（DB側にも lower(email) の一意索引がある）
async function findUserByEmail(email: string) {
  const { rows } = await pool.query(
    `SELECT id, display_name, role, is_demo
       FROM users
      WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
    [email],
  );
  if (rows.length === 0) return null;
  return {
    id: Number(rows[0].id),
    displayName: String(rows[0].display_name),
    role: String(rows[0].role),
    isDemo: rows[0].is_demo === true,
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PostgresAdapter(pool),

  // DB方式。7日。ブラウザを閉じても維持される。
  // 既定は 30日（2592000秒）なので、明示して下げている。
  // updateAge は既定の1日のまま。0 にすると毎アクセスで sessions を UPDATE することになる
  session: {
    strategy: "database",
    maxAge: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },

  // Auth.js の既定のログイン画面を使わず、自分の画面に寄せる。
  // 拒否（AccessDenied）も /login に返し、そこで理由を出す
  pages: { signIn: "/login", error: "/login" },

  providers: [
    Google({
      // 既に users に登録済みの人が初めてログインしたとき、
      // accounts に行が無いことを理由に OAuthAccountNotLinked で弾かれるのを防ぐ。
      //
      // この設定が警戒されるのは、複数の提供元を許す場合に
      // 「同じメールアドレスを名乗る別の提供元」で乗っ取られる経路があるため。
      // tenko は Google 単独で、下の signIn で email_verified も自分で確認している。
      //
      // **将来 Microsoft など別の提供元を追加する場合、この設定を必ず見直すこと。**
      // 提供元が2つ以上になった時点で、この設定は安全ではなくなる。
      allowDangerousEmailAccountLinking: true,
    }),
  ],

  callbacks: {
    // 誰を中に入れるか。
    //
    // ここで偽を返すと AccessDenied が投げられ、アダプタの createUser / linkAccount より前に止まる。
    // （@auth/core@0.41.3 の callback ルートの実装で、handleAuthorized が handleLoginOrRegister
    //   より前に呼ばれることを確認済み）
    // したがって未登録の人でログインを試みても、DBには行が1つも作られない。
    async signIn({ profile, account }) {
      if (account?.provider !== "google") return false;

      // Google が「このアドレスは検証済み」と言っていること。
      // 検証されていないアドレスは、名乗るだけで他人になれてしまう
      if (profile?.email_verified !== true) return false;

      const email = typeof profile.email === "string" ? profile.email : "";
      if (email.length === 0) return false;

      const u = await findUserByEmail(email);

      // 未登録。ここで止める。DBには何も書かない
      if (!u) return false;

      // デモ用の利用者はログインできない。
      // DB側にも「is_demo なら email は NULL」の制約があるため、本来ここには到達しない。
      // 2重にしてあるのは、片方が外れたときに黙って通らないようにするため
      if (u.isDemo) return false;

      // 最初の管理者。環境変数に載っているアドレスなら admin にする。
      // 降格はしない（環境変数の書き間違いで管理者が全員いなくなると、
      // 噴水のお知らせを誰も書けなくなるため）
      if (ADMIN_EMAILS.includes(email.toLowerCase()) && u.role !== "admin") {
        await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [u.id]);
        console.log("[auth] id=" + u.id + " を admin にした（TENKO_ADMIN_EMAILS による）");
      }

      return true;
    },

    // 画面とAPIに渡すセッションの中身。
    //
    // 権限はここで持たせない。role を入れているのは表示の分岐のためだけであり、
    // 判定は必ずAPI側で users を引き直して行う（Phase 4 で確立した方針）。
    //
    // id は必ず数値に直す。pg は bigint を文字列で返すため、
    // ここを通さないと "3" === 3 が偽になる箇所が生まれる
    async session({ session, user }) {
      const { rows } = await pool.query(
        `SELECT id, display_name, role FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [user.id],
      );
      if (rows.length === 0) {
        // 削除された利用者。セッション行が生きていても中には入れない。
        // id=0 は「利用者なし」を表す。担保はここではなく、
        // API側が users を引き直して弾くこと（段階3）にある
        return {
          ...session,
          user: { ...session.user, id: 0, displayName: "", role: "" },
        } as unknown as Session;
      }
      // Auth.js の型では user.id が文字列（AdapterUser）になっているため、
      // 数値に直した形へは型の変換が要る。値の正しさは session コールバックのこの1か所で担保する
      return {
        ...session,
        user: {
          ...session.user,
          id: Number(rows[0].id),
          displayName: String(rows[0].display_name),
          role: String(rows[0].role),
        },
      } as unknown as Session;
    },
  },
});
