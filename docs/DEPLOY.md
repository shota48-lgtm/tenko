# DEPLOY — tenko の公開手順（Phase 5 段階7）

**この手順はPOが実行する。** アカウントの作成・鍵の入力・支払い情報に関わる操作は、CCが代行しない。

> **2026-08-13、この手順で実際に公開した。そのとき5箇所で止まった。**
> 止まった箇所はすべてこの文書に書き足してある（🔴 の印を付けた）。
> **次にこの手順をなぞる人が同じ場所で止まらないことが、この文書の目的である。**
>
> 公開したもの:
>
> | | URL |
> |---|---|
> | アプリ | `https://tenko-eight.vercel.app` |
> | ws-server | `wss://tenko-ws.onrender.com` |
> | リポジトリ | `https://github.com/shota48-lgtm/tenko`（公開） |
> | ブランチ | `feature/phase5-auth`（Vercel の Production Branch もこれ） |

構成:

```
ブラウザ ──HTTPS──> Vercel（Next.js。アプリ本体）──> Neon（PostgreSQL）
    └────WSS─────> Render（ws-server。在席・位置・呼びかけ）
                      └──HTTP──> Vercel（/api/demo-presence と /api/ws-verify）
```

**費用は一切かけない。** Render・Vercel・Neon のいずれも無料枠のまま使う。
カードの登録や有料プランへの移行が必要になったら、**そこで止めてPOが判断する**。

---

## 0. 先に必要なもの

| # | 必要なもの | いま |
|---|---|---|
| 1 | GitHub のリポジトリ（Render も Vercel も Git から取る） | **無い。** `git remote -v` が空。**最初にこれを作る** |
| 2 | Render のアカウント | POが作る（カード不要） |
| 3 | Vercel のアカウント | POが作る |
| 4 | Neon の接続文字列 | ある（`.env.local`） |
| 5 | Google OAuth クライアント | ある。**本番のリダイレクトURIを後で足す（3-1節）** |
| 6 | `WS_NOTIFY_TOKEN` | 🔴 **`.env.local` に無い。ここで新しく作る**（下記） |

### 🔴 `WS_NOTIFY_TOKEN` は「新しく作る値」である

他の鍵は `.env.local` から写すが、**これだけは元が無い。**
`ws-server/index.js` が `|| "dev-notify-token"` に落ちるため、
**手元では未設定でも動いてしまい、本番で未設定だと既定値のまま動く**（投稿の通知の合言葉が既定値になる）。

作り方（値は画面に出る。共有中は避ける）:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

出た値を、**Render と Vercel の両方に同じものを入れる**。

---

## 1. GitHub にリポジトリを作って push する

**PO が GitHub で空のリポジトリを作る**（名前は `tenko`。**Private を推奨**）。
作ったら、以下をそのまま実行する（`<あなたのGitHubのユーザー名>` だけ置き換える）。

```powershell
cd "$env:USERPROFILE\OneDrive\デスクトップ\claude\tenko"; git remote add origin https://github.com/<あなたのGitHubのユーザー名>/tenko.git; git push -u origin feature/phase5-auth
```

> `.env.local` は `.gitignore` で除外されており、履歴にも一度も入っていない
> （段階2で `git log --all -- .env*` が「なし」であることを確認済み）。

---

## 2. Render に ws-server を出す（**アプリより先**）

1. https://dashboard.render.com/ → **New +** → **Web Service**
2. **Connect a repository** で、1で作ったリポジトリを選ぶ
3. 設定:
   | 項目 | 値 |
   |---|---|
   | Name | `tenko-ws` |
   | Region | `Singapore`（日本から最も近い無料枠の地域） |
   | Branch | `feature/phase5-auth`（マージ後は `main`） |
   | Root Directory | `ws-server` |
   | Runtime | `Node` |
   | Build Command | `npm install` |
   | Start Command | `node index.js` |
   | Instance Type | **Free** |
4. **Environment Variables** に以下を入れる（**値は画面で直接入力する。チャットに貼らない**）:
   | 名前 | 値 |
   |---|---|
   | `TENKO_WS_TICKET_SECRET` | `.env.local` の同名の値**と同じもの** |
   | `TENKO_WS_INTERNAL_TOKEN` | 同上 |
   | `WS_NOTIFY_TOKEN` | 任意の長い乱数（アプリ側にも同じ値を入れる） |
   | `TENKO_API` | **後で入れる**（Vercel のURLが決まってから）。いまは空でよい |
   | `TENKO_PUBLIC_VIEW` | `1` |
5. **Create Web Service**
6. デプロイが終わったら、`https://tenko-ws.onrender.com/healthz` を開く。
   **`ok 0` と出れば動いている。**

> `PORT` は Render が自動で入れる。こちらで設定しない。
> `render.yaml` をリポジトリに置いてあるので、Blueprint から作ってもよい。

---

## 3. Vercel にアプリを出す

1. https://vercel.com/new → 1で作ったリポジトリを選ぶ
2. Framework は Next.js が自動で選ばれる。Root Directory は**空のまま**（リポジトリの直下）
3. **Environment Variables** に以下を入れる（**値は画面で直接入力する**）:
   | 名前 | 値 |
   |---|---|
   | `DATABASE_URL` | `.env.local` と同じ |
   | `AUTH_SECRET` | 同上 |
   | `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | 同上 |
   | `TENKO_ADMIN_EMAILS` | 同上 |
   | `TENKO_WS_TICKET_SECRET` | 同上（**Render と同じ値**） |
   | `TENKO_WS_INTERNAL_TOKEN` | 同上（**Render と同じ値**） |
   | `WS_NOTIFY_TOKEN` | Render に入れたものと同じ |
   | `TENKO_PUBLIC_VIEW` | `1` |
   | **`NEXT_PUBLIC_WS_URL`** | 🔴 **`wss://tenko-ws.onrender.com`** ← **ws:// ではなく wss://** |
   | `AUTH_URL` | デプロイ後のURL（例 `https://tenko-eight.vercel.app`） |
4. **Deploy**

### 🔴 `NEXT_PUBLIC_WS_URL` を入れ忘れると「接続しています…」で止まる

**これが無いと、画面は ws-server に繋ぎに行かない**（既定の `ws://localhost:8080` を見に行き、
本番のブラウザからは届かない）。村とデモの20人は見えるが、在席が動かず、
ヘッダが「接続しています…」のままになる。

**`NEXT_PUBLIC_` で始まる環境変数はビルドのときに埋め込まれる。**
後から追加した場合、**必ず再ビルド（Redeploy）が要る。** 環境変数を保存しただけでは反映されない。

### 🔴 Production Branch は Settings → Git ではない

作業ブランチ（`feature/phase5-auth`）を本番に出すには:

**Settings → Environments → Production → Branch Tracking** でブランチを指定する。

### 🔴 「Redeploy」ではブランチは切り替わらない

Redeploy は**同じコミットを焼き直すだけ**である。
別のブランチの内容を本番にするには、**そのブランチに push する**（push が本番デプロイを発火させる）。

### 🔴 3-1. Google のリダイレクトURIを足す（**忘れるとログインだけが失敗する**）

1. https://console.cloud.google.com/ → プロジェクト `tenko` を選ぶ
2. 左メニュー **APIとサービス → 認証情報**
3. **OAuth 2.0 クライアント ID** の一覧から、使っているクライアントの名前を押す
4. **承認済みのリダイレクト URI** の欄で「**URI を追加**」を押し、次を入れる:

```
https://<Vercelのドメイン>/api/auth/callback/google
```

5. **保存**

**ローカル用（`http://localhost:3000/api/auth/callback/google`）は消さない。** 両方あってよい。

忘れた場合の症状: **村は見えるが、ログインのときだけ Google が
`エラー 400: redirect_uri_mismatch` を返す。** アプリ側のログには何も出ない。

**保存してから反映まで数分かかることがある**（Google の案内では最大で数時間）。
直後に試して失敗しても、5分ほど置いてもう一度試すこと。

### 3-2. Render に Vercel のURLを入れる

Render → `tenko-ws` → Environment → `TENKO_API` に `https://<Vercelのドメイン>` を入れて保存する
（保存すると自動で再デプロイされる）。

---

## 4. 最初に確認すること（**他の何よりも先**）

**Render のプロキシが `Sec-WebSocket-Protocol` を通すか。**

1. 本番URLを開いてログインする
2. Render の **Logs** を見る

| ログに出るもの | 意味 | 次にすること |
|---|---|---|
| `[open] viewer 認証済み userId=…` | **通った。作り直し不要** | 5へ進む |
| `[open] viewer 見るだけ（券なし…）` | ヘッダが落ちている | **止めてCCに報告する**（+2.0h の作り直しが要る） |
| `[open]` が出ない・ブラウザが 1006 で切れる | ハンドシェイクごと落ちている | 同上 |

---

## 5. 動作の確認

```powershell
cd "$env:USERPROFILE\OneDrive\デスクトップ\claude\tenko"; node scripts\measure-phase5.js https://<Vercelのドメイン>
```

```powershell
cd "$env:USERPROFILE\OneDrive\デスクトップ\claude\tenko"; $env:TENKO_API="https://<Vercelのドメイン>"; $env:TENKO_WS="wss://tenko-ws.onrender.com"; node scripts\attack-public-view.js; node scripts\attack-phase5-auth.js; node scripts\attack-presence.js
```

### 🔴 本番に試験を向けるときの落とし穴（2026-08-13 に実際に踏んだ）

| こと | 症状 | 対処 |
|---|---|---|
| **セッションCookieの名前が変わる** | 本番（https）では `__Secure-authjs.session-token`。手元の名前で送ると**すべて 401** になり、「拒否された＝守られている」と読めてしまう | 試験スクリプトは URL が https なら `__Secure-` を付ける（対応済み） |
| **close code が届かない** | Render 越しだと `close(4003)` が画面に届かない。断られた接続が開いたまま残る | 断りは**知らせ（`auth.rejected`）で判定する**。close code だけを見ない（対応済み） |
| **往復が遅い** | 手元の待ち時間（500ms）では、断りが届く前に判定してしまう | 遠い相手のときは3秒待つ（対応済み） |

**いずれも「守れていない」ではなく「試験が壊れる」形の問題である。**
壊れた試験は、**壊れたことを「合格」として報告する。**

確認する項目:

| # | 見るもの | 期待 |
|---|---|---|
| 1 | シークレットウィンドウで本番URLを開く | 村が見え、デモ20人と吹き出しが出る |
| 2 | ログインする | 自分のアバターが出る。Render のログに `認証済み` |
| 3 | **15分放置する** | Render のログに停止（`Exited`）が出る |
| 4 | 停止した状態で本番URLを開く | **村と20人は見える**（最初のHTMLに載っているため）。ヘッダは「接続しています…」 |
| 5 | そのまま待つ | 数十秒で ws-server が起き、繋がる。**何秒かかったかを測る** |
| 6 | 誰かが村にいる間に15分待つ | **停止しない**（WSのメッセージが停止を先送りする） |
| 7 | `assertSameOrigin` | 下の 5-1 |
| 8 | `TENKO_PUBLIC_VIEW=0` | Vercel と Render の両方を 0 にして再デプロイ。未ログインで `/` を開くと `/login` に飛ぶ |

### 5-1. `assertSameOrigin` が本番で働くか（段階4からの仮説）

別のサイトを名乗って書き込みを試す。**403 が返れば働いている。**

```powershell
cd "$env:USERPROFILE\OneDrive\デスクトップ\claude\tenko"; curl.exe -i -X PUT "https://<Vercelのドメイン>/api/notes" -H "Content-Type: application/json" -H "Origin: https://evil.example.com" -d "{\"body\":\"別サイトから\"}"
```

期待: `HTTP/2 403` と `{"error":"別のサイトからの操作は受け付けません"}`
（ログインしていない状態なら 401 が先に返る。**ログイン済みのCookieを付けて試すこと**が本来の確認になる。
ブラウザの開発者ツールのコンソールで、本番のページを開いた状態で以下を実行するのが確実）:

```js
fetch("/api/notes", { method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ body: "同一オリジンから" }) }).then(r => console.log("同一オリジン:", r.status));
```

同一オリジンからは 200、`Origin` を偽装した curl では 403 になれば、期待どおり。

---

## 6. 戻し方

| 戻すもの | 手順 |
|---|---|
| アプリ | Vercel の Deployments から前のデプロイを Promote |
| ws-server | Render の Deploys から前のデプロイを Rollback |
| 見るだけモードだけ止める | Vercel と Render の `TENKO_PUBLIC_VIEW` を `0` にする |
| 全員を締め出す | Neon で `DELETE FROM sessions;` |
| DBの構造 | `docs/PHASE5_SCHEMA.sql` の末尾のロールバックSQL |

---

## 7. 無料枠で知っておくこと

| こと | 影響 |
|---|---|
| Render は15分の無通信で停止する | 停止中でも**村とデモ20人は見える**（最初のHTMLに載っている）。動きだけが止まる |
| 起動に時間がかかる | 開いてから数十秒、繋がらない状態が続く。ヘッダに「接続しています…」を出している |
| WSのメッセージも停止を先送りする | **誰かが村にいる限り止まらない**（2026年2月の変更） |
| 定期pingで起こし続けない | 異常に多い通信を発生させる無料サービスは停止されうる。**規約と competing する手は採らない**（PO判断） |
| Neon にも無料枠の上限がある | 呼び出しは1日あたり最大 2880 回（ws-server が起きている間だけ）。寝ている間は0回 |
