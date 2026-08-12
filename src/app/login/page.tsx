// ログイン画面と、拒否されたときの説明。
//
// この画面は Server Component。セッションの確認は auth() をここで直接呼ぶ。
// proxy（middleware）の判定は担保にしない（Next.js 16 の Proxy のドキュメント自身が
// 「Proxy だけに頼らず、各 Server Function の中で検証せよ」と書いている）。
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

// 拒否の理由。Auth.js が ?error= で返してくる。
// 出す文面は「登録されているかどうか」以上のことを言わない。
// 誰が登録されているかを推測させないため
const MESSAGES: Record<string, { title: string; body: string }> = {
  AccessDenied: {
    title: "このアプリは、あらかじめ登録された方だけが使えます",
    body:
      "ログインした Google アカウントは登録されていません。" +
      "村を見るだけであれば、ログインせずにご覧いただけます。",
  },
  OAuthAccountNotLinked: {
    title: "このアドレスは、別の方法で登録されています",
    body: "同じメールアドレスで、別のログイン方法が使われています。管理者にご連絡ください。",
  },
  Configuration: {
    title: "ログインの設定が済んでいません",
    body: "認証の設定（環境変数）が足りていません。管理者にご連絡ください。",
  },
  Verification: {
    title: "確認できませんでした",
    body: "時間をおいて、もう一度お試しください。",
  },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  // 既に入れている人をここに置いても意味がないので、村へ送る
  if (session?.user?.id) redirect("/");

  const { error } = await searchParams;
  const msg = error ? (MESSAGES[error] ?? MESSAGES.Verification) : null;

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "var(--tk-paper)",
        color: "var(--tk-ink)",
      }}
    >
      <div className="tk-panel" style={{ maxWidth: 420, width: "100%", padding: 20 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>tenko</h1>
        <p className="tk-soft" style={{ fontSize: 13, marginBottom: 16 }}>
          チャットと勤怠を繋いだオフィス
        </p>

        {msg && (
          <div
            role="alert"
            style={{
              border: "1px solid var(--tk-red)",
              background: "#f6e2dc",
              padding: 12,
              marginBottom: 16,
              fontSize: 13,
              lineHeight: 1.7,
            }}
          >
            <strong style={{ display: "block", marginBottom: 4 }}>{msg.title}</strong>
            {msg.body}
          </div>
        )}

        {/* ログインは Server Action から呼ぶ。
            クライアントに認証の処理を持たせない */}
        <form
          action={async () => {
            "use server";
            // 戻り先は常に村。外部URLへ飛ばす経路を作らない（オープンリダイレクト対策）
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button className="tk-btn" type="submit" style={{ width: "100%", padding: "10px 12px" }}>
            Google でログイン
          </button>
        </form>

        <p className="tk-soft" style={{ fontSize: 12, marginTop: 16, lineHeight: 1.7 }}>
          ログインしなくても村は見られます。
          <br />
          自分のアバターを出す・話す・勤怠をつけるには、ログインが必要です。
        </p>

        <p style={{ marginTop: 16 }}>
          <Link href="/" className="tk-soft" style={{ fontSize: 13, textDecoration: "underline" }}>
            村を見る（ログインしない）
          </Link>
        </p>
      </div>
    </main>
  );
}
