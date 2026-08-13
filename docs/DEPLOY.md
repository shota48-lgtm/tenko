# DEPLOY — tenko の公開手順（Phase 5 段階7）

**この手順はPOが実行する。** アカウントの作成・鍵の入力・支払い情報に関わる操作は、CCが代行しない。

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
| 5 | Google OAuth クライアント | ある。**本番のリダイレクトURIを後で足す** |

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
   | `NEXT_PUBLIC_WS_URL` | `wss://tenko-ws.onrender.com` ← **ws:// ではなく wss://** |
   | `AUTH_URL` | デプロイ後のURL（例 `https://tenko.vercel.app`） |
4. **Deploy**

### 3-1. Google のリダイレクトURIを足す

Google Cloud → 認証情報 → OAuth クライアント → **承認済みのリダイレクトURI** に追加:

```
https://<Vercelのドメイン>/api/auth/callback/google
```

**ローカル用（`http://localhost:3000/...`）は消さない。** 両方あってよい。

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
