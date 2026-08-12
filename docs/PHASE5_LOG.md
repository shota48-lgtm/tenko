# PHASE5_LOG

Phase 5（認証）の作業記録。設計は `docs/PHASE5_AUTH_DESIGN.md`。

---

## 2026-08-13 段階0〜2

ブランチ: `feature/phase5-auth`（main へのマージ・push は行っていない）

### 到達点

| 段階 | 内容 | 状態 |
|---|---|---|
| 0 | 準備 | **PO待ち。** Google の OAuth クライアントが要る（手順は本ファイル末尾） |
| 1 | DDL + `SELECT *` の潰し込み | **完了**（実測あり） |
| 2 | Auth.js 導入 | **コードは完了。ログインの実機確認だけが PO待ち**（認証情報が無いと動かせない） |

---

## 1. 実行したDDL

`scripts/apply-phase5-ddl.js --apply` で実行した。全文は `docs/PHASE5_SCHEMA.sql`。**15文**。

実行前の確認（スクリプトが自動で行う）:

```
接続先の database: neondb
tenko の表として見つかったもの: attendance_drafts, attendance_records, messages, rooms, users
実行前のトリガー: attendance_drafts_freeze, attendance_records_freeze
```

実行結果:

```
OK: ALTER TABLE users ADD COLUMN name TEXT
OK: ALTER TABLE users ADD COLUMN email TEXT
OK: ALTER TABLE users ADD COLUMN "emailVerified" TIMESTAMPTZ
OK: ALTER TABLE users ADD COLUMN image TEXT
OK: CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL
OK: ALTER TABLE users ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT false
OK: ALTER TABLE users ADD CONSTRAINT users_demo_has_no_email CHECK (is_demo = false OR email IS NULL)
OK: CREATE TABLE accounts (...)
OK: CREATE UNIQUE INDEX accounts_provider_uq ON accounts (provider, "providerAccountId")
OK: CREATE INDEX accounts_user_idx ON accounts ("userId")
OK: CREATE TABLE sessions (...)
OK: CREATE UNIQUE INDEX sessions_token_uq ON sessions ("sessionToken")
OK: CREATE INDEX sessions_user_idx ON sessions ("userId")
OK: CREATE TABLE verification_token (...)
OK: CREATE TABLE demo_presence (...)

実行後のトリガー: attendance_drafts_freeze, attendance_records_freeze
トリガーは変わっていないか: はい
users の列: id, display_name, role, created_at, deleted_at, manager_id, name, email, emailVerified, image, is_demo
表の一覧: accounts, announcement_reads, announcements, attendance_drafts, attendance_records,
         daily_notes, demo_presence, messages, read_states, room_members, rooms, sessions,
         users, verification_token
```

実行条件の遵守:

| 条件 | 結果 |
|---|---|
| 実行前にロールバックSQLをファイルに書く | `docs/PHASE5_SCHEMA.sql` 末尾に記載。スクリプトは実行前に画面にも出す |
| 実行したDDLを1文残らず記録 | 同ファイル。スクリプトの `STATEMENTS` と一致させてある |
| `DROP` / `TRUNCATE` を実行しない | スクリプトに `FORBIDDEN` 判定を置き、含まれていれば実行前に落ちる |
| 既存の列と制約を変更しない | **設計から1文落とした**（下記） |
| 既存のトリガー2つを変更・削除しない | 実行の前後で名前を突き合わせた。同一 |
| tenko 以外のDBに接続しない | 実行前に `current_database()` と tenko の主要5表の存在を確認。無ければ実行せず終了 |

### 設計から落とした1文

```sql
ALTER TABLE users ALTER COLUMN display_name SET DEFAULT '(未登録)';
```

**実行しなかった。** 既存の列の既定値を変える操作であり、実行条件「既存テーブルの既存の列と制約を変更しないこと」に反するため。

この文はもともと「アダプタが `createUser` を呼んだときに 500 にならない保険」だった。
未登録者は `signIn` コールバックで先に落ちるため `createUser` には到達せず、保険が無くても設計は成立する。
設計書にも落とした旨を記録した。

### ロールバックSQL

```sql
DROP TABLE IF EXISTS demo_presence;
DROP TABLE IF EXISTS verification_token;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS accounts;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_demo_has_no_email;
ALTER TABLE users DROP COLUMN IF EXISTS is_demo;
DROP INDEX IF EXISTS users_email_uq;
ALTER TABLE users DROP COLUMN IF EXISTS image;
ALTER TABLE users DROP COLUMN IF EXISTS "emailVerified";
ALTER TABLE users DROP COLUMN IF EXISTS email;
ALTER TABLE users DROP COLUMN IF EXISTS name;
```

**注意**: `DROP COLUMN email` は登録済みのアドレスを失う。
戻す前に `SELECT id, email FROM users WHERE email IS NOT NULL` を控えること。

---

## 2. `SELECT *` の潰し込みと、漏れていないことの実測

### 静的な確認

`src/` と `ws-server/` を `SELECT *` / `select *` / `RETURNING *` / `u.*` で全数検索した。
**該当は0件。** 既存のコードは全て列を明示して選んでいた。潰し込みの必要は無かった。

### 実測（コードを直しただけで済ませない）

列を追加した**あと**に、`scripts/verify-no-leak.js` で全13経路の応答本文を実際に取得し、
`email` / `emailVerified` / `"image"` / `is_demo` / `@` を含まないことを確かめた。

```
OK  200 /api/rooms len=460
OK  200 /api/users len=1747
OK  200 /api/notes len=21
OK  200 /api/notes?user=1 len=22
OK  200 /api/me?user=1 len=53
OK  200 /api/village?user=1 len=30
OK  200 /api/announcements?user=1 len=2027
OK  200 /api/rooms/1/messages?after=0&limit=5 len=1065
OK  200 /api/attendance/drafts?user=1 len=791
OK  403 /api/attendance/approvals?user=1 len=28
OK  200 /api/attendance/corrections?user=1 len=51
OK  200 /api/attendance/anomalies?user=1 len=518
OK  400 /api/attendance/monthly?... len=30

漏れ・失敗: 0 件 / 13 経路
```

`/api/attendance/monthly` は上の実行では引数が足りず 400 だったため、正しい引数で取り直した:

```
GET /api/attendance/monthly?actor=1&user=1&year=2026&month=8
len=175  CSV（# tenko 勤怠記録,テスト太郎(id=1),2026年08月 …）
email を含むか: False
```

**13経路すべてで漏れなし。**

### 実測して分かったこと（重要）

アダプタの `getUser` は `select * from users where id = $1` を投げるため、
**Auth.js の内部には `email` も `is_demo` も入る**（`scripts/probe-id-type.mjs` で確認）。

```
アダプタが返した鍵: id, display_name, role, created_at, deleted_at, manager_id,
                    name, email, emailVerified, image, is_demo
```

これはアダプタの実装であり、こちらでは変えられない。
**画面に出るのは `auth.ts` の `session` コールバックが組み立てたものだけ**にしてあるため、
村の画面や自作APIには流れない。

ただし1点、意図して残した箇所がある:
Auth.js の既定のセッションには `user.email`（**ログインした本人のアドレス**）が入る。
これは標準の挙動で、他人のアドレスは一切含まれない。消す必要は無いと判断した。
**不要と判断されるなら `session` コールバックで落とせる**（1行）。POの判断を仰ぐ。

---

## 3. 段階2で書いたもの

| ファイル | 内容 |
|---|---|
| `src/auth.ts` | Auth.js の設定。プロバイダ / セッション / `signIn` / `session` |
| `src/app/api/auth/[...nextauth]/route.ts` | Auth.js の入口。繋ぐだけ |
| `src/app/login/page.tsx` | ログイン画面と拒否の説明。Server Component |
| `src/types/next-auth.d.ts` | セッションの型（`id: number` / `displayName` / `role`） |
| `scripts/apply-phase5-ddl.js` | 段階1のDDL |
| `scripts/verify-no-leak.js` | 応答に `email` 等が混ざらないことの実測 |
| `scripts/probe-id-type.mjs` | `bigint` の型の実測 |

**既存のAPIには一切手を入れていない。** `actor.ts` も `village-client.tsx` も無変更。
段階2の時点では既存の権限の検証は今までどおり効いている（破壊試験で確認。9節）。

パッケージ（完全にピン留め。設計書に挙げた以外は追加していない）:

```
"@auth/pg-adapter": "1.11.3",
"next-auth": "5.0.0-beta.32",
```

`npx tsc --noEmit` は 0 で通る。

---

## 4. ログインの実機確認

### できたこと

`/login` と `/login?error=AccessDenied` が意図どおり描画されることを、ブラウザで確認した（スクリーンショットあり）。

### できなかったこと（**PO待ち**）

**Google のログイン画面まで遷移させられなかった。** 認証情報が無いため。

`.env.local` にあるのは `DATABASE_URL` の1件のみで、`AUTH_SECRET` も Google のクライアントも無い。
この状態での実測:

```
GET /api/auth/providers -> HTTP 500
GET /api/auth/session   -> HTTP 500
GET /api/auth/csrf      -> HTTP 500
サーバのログ: [auth][error] MissingSecret: Please define a `secret`.
```

一方で `/login` は 200 で描画される。**`auth()` は秘密鍵が無くても例外を投げず null を返す**ためで、
これは「ログインしていない人には村を見せる」設計にとっては都合がよい挙動である（段階4で効いてくる）。

したがって以下は**すべて未確認のまま**である。段階0の認証情報が入り次第、続けて確認する。

- Google でログインできること
- 未登録のアドレスで拒否され、DBに1行も作られないこと
- `TENKO_ADMIN_EMAILS` のアドレスが `admin` になること
- 既存の `users` に email を紐づけた人がログインできること
- `OAuthAccountNotLinked` が実際に出るかどうか

**これらは「設計どおりのはず」であって、実測ではない。** 区別して扱うこと。

### ローカルで再現しないと分かっていること

- **Cookie の `secure` 属性**: `http://localhost` では `secure` が付かない。本番（https）で初めて付く
- **別ドメイン間の挙動**: ローカルはアプリも ws-server も localhost で、実質同一オリジンに近い。
  Vercel（アプリ）と Railway（ws）に分かれたときの Cookie の扱いは、**ここでは再現しない**（段階6の論点）
- **`AUTH_URL` の自動検出**: Vercel 上でのみ効く経路がある

---

## 5. `bigint` の id は文字列で返るか（設計書の「要実測」）

**文字列で返る。実測した。**

```
素の pg  : id="1" typeof=string / is_demo=false typeof=boolean
アダプタ : id="1" typeof=string
```

`auth.ts` の `session` コールバックで `Number()` に通している。
これを通さないと `session.user.id === user.id` のような比較が静かに偽になる。

---

## 6. Cookie の設定値と理由

**Auth.js の既定のままにした。** 変えていない。

| Cookie | httpOnly | sameSite | secure | path |
|---|---|---|---|---|
| `authjs.session-token`（本番は `__Secure-` 付き） | true | lax | 本番のみ true | / |
| `authjs.csrf-token`（本番は `__Host-` 付き） | true | lax | 本番のみ true | / |
| `authjs.pkce.code_verifier` / `authjs.state` | true | lax | 本番のみ true | /（900秒） |

理由:

- **httpOnly: true** — JavaScript から読めない。画面のスクリプトが漏れてもセッションを持ち出せない
- **secure: 本番 true** — https でのみ送る。ローカルの http で開発できるよう、自動で切り替わる
- **sameSite: lax** — `strict` にしない。**Google から戻ってくる遷移で Cookie が送られず、ログインが完了しなくなる**ため。
  `lax` でも他サイトからの POST には送られないので、書き込みのCSRFは防げる。
  ただしこれに頼らず、段階3で `Origin` の確認を全ての書き込み経路に入れる（多層）
- `__Host-` / `__Secure-` の接頭辞は、Cookie の書き換えに対する追加の防御。既定で付く

出典はドキュメントではなく `@auth/core@0.41.3` の `lib/utils/cookie.js` の**実装**である
（ドキュメントに既定値の一覧が無い）。

---

## 7. proxy に頼らないこと

**この段階では `proxy.ts` を作っていない**（段階4の作業）。

`/login` は Server Component で `auth()` を直接呼んでいる。
既存のAPIは今までどおり `actor.ts` で検証している。
proxy を「守り」として使う経路は、現時点で1つも存在しない。

---

## 8. 決めたこと（POの判断に基づく実装方針）

| # | 判断 | 反映先 |
|---|---|---|
| 1 | `allowDangerousEmailAccountLinking: true` を付ける。**Google 単独である限り安全。別の提供元を追加する場合は必ず見直す** | `src/auth.ts` のコメント / 設計書3節 |
| 2 | `/api/notes` は開放するが**デモ用の利用者の分だけ** | 設計書4節（実装は段階4） |
| 3 | `/api/ws-verify` の失敗時は接続を維持。**連続5回で警告、連続10回（約10分）で認証済み接続を切り、見るだけに落とす** | 設計書6節（実装は段階6） |
| 4 | 村に出すデモ用の利用者は20人前後。残りは一覧にのみ出す | 設計書8節（実装は段階5） |
| 5 | 見るだけモードの噴水は「押せるが中身は見えない」 | 設計書4節（実装は段階4） |

判断3の内訳（CCが決めた部分）:

- 1〜4回（〜4分）: ログに出すだけ
- 5回（5分）: 警告に上げる。新しい接続は受け続ける（券の検証はHMACだけででき、アプリに依存しない）
- **10回（10分）: 認証済みの接続を `close(4001)` で切り、確認が1回成功するまで見るだけ扱いにする**

60秒の遅延を許容できるとした根拠は「短時間の障害なら在席の表示が古くなるだけ」だった。
10分続く障害はその前提が崩れている。切られた人はアプリが復旧していれば数秒で戻り、
復旧していなければ券が取れないので、そもそも入れない状態と一致する。

---

## 9. 破壊試験（段階2の完了時）

既存のスクリプトをそのまま実行した。**認証を入れる過程で壊れた保証は無い。**

| 試験 | 結果 | 出典 |
|---|---|---|
| WebSocket 経由で投稿を保存できないこと | **保たれている**（messages 10 → 10。増えない） | `attack-presence.js` / `attack-phase45.js` |
| 承認済みの勤怠記録が変更できないこと | **保たれている**（例外: 承認済みの勤怠記録は変更できません id=1） | `attack-phase45.js` |
| 確定・却下済みの下書きが変更できないこと | **保たれている**（例外: 確定または却下済みの下書きは変更できません id=1） | `attack-phase45.js` |
| 他人の勤怠記録を承認できないこと（4通り） | **保たれている**。本人 403 / 無関係 member 403 / 別の上長 403 / 担当の上長のみ 200 | `attack-phase45.js` |
| 他人の在席状態を変更できないこと | **既知の穴のまま**（S6）。WSに認証が無いため変更できてしまう。**段階6で塞ぐ**。名前は配信していないため騙れない | `attack-presence.js` |
| 他人のアバターを移動できないこと | **保たれている**（被害者は動いていない。添えたIDは読まれない） | `attack-phase48.js` |
| `member` がお知らせを書き込めないこと | **保たれている**（member 403 / manager 403 / admin 201。DBの書き手は全て admin の id=6） | `attack-phase49.js` |

あわせて確認できたもの（回帰）:
定員超過で建物に入れない（4/4で断り）/ 呼びかけの連打制限（15回中0回通過）/
不正な座標の扱い / 入力の検証（201文字は400、空は400）/ 存在しない利用者は401。

### 失敗した1件（Phase 5 とは無関係）

`scripts/verify-phase4-permissions.js` が最後まで走らなかった。

```
ERR: duplicate key value violates unique constraint "messages_dedupe_uq"
```

原因: このスクリプトは固定のUUIDで投稿を作り、そのあと `messages.user_id` を書き換える作りになっている。
2回目以降の実行で `(user_id, client_msg_id)` が既存行と衝突する。**スクリプト自身が繰り返し実行できない**。

Phase 5 の変更が原因ではない（`users` に列を足しただけで `messages` には触れていない）。
このスクリプトが見る「承認の権限4通り」は `attack-phase45.js` の末尾が同じ範囲を実際に確認しており、
そちらは通っている。**スクリプトの修正は段階3で行う**（今回の範囲外の変更を混ぜないため）。

---

## 10. 段階3以降に向けて分かったこと・懸念

1. **`village-client.tsx` は1257行あり、`me.id` を30か所以上で使っている。**
   段階3の書き換えはここが本体になる。`?user=` を外すだけでなく、
   `devUser()`（画面が自分で利用者を決めている関数）そのものを消す必要がある
2. **`/api/rooms/[roomId]/messages` は `actor.ts` を使っていない。**
   独自に `const CURRENT_USER_ID = Number(process.env.TENKO_DEV_USER_ID ?? 1)` を持っている。
   段階3の「`requestedUserId` を消す」だけでは**この経路が残る**。見落としやすい
3. アダプタが `select *` を使う以上、**`users` に機微な列を足すときは常に注意が要る**。
   段階3で入れる `verify-auth-coverage.js` に、`SELECT *` の全数検索も入れる
4. 開発サーバに Turbopack の内部エラー（HMRの panic）が1度出た。
   ファイルを足した直後の再読み込みで発生し、再起動で消えた。**実害は確認していない**

---

## 11. 現時点で答えを持たない事項

| 事項 | 区分 | 内容 |
|---|---|---|
| Google でログインできるか | **未検証** | 認証情報が無く試せていない。段階0がPO待ち |
| 未登録が拒否され、DBに行が作られないか | **未検証**（実装の順序は確認済み） | `@auth/core` の実装で `signIn` が `createUser` より前に走ることは確認済み。**実際に試してはいない** |
| `TENKO_ADMIN_EMAILS` による昇格 | **未検証** | 同上 |
| `OAuthAccountNotLinked` が出るか | **仮説のまま** | `allowDangerousEmailAccountLinking` を付けたため、**そもそも出ない見込み**。外して試せば確認できるが、確認のために危険側の設定へ倒す価値は無いと判断した |
| 本番（別ドメイン）での Cookie の挙動 | **未検証** | ローカルでは再現しない。段階6の spike で確認する |
| Vercel → Neon のセッション確認の実遅延 | **要実測** | 段階3の完了時に測る |
| セッションに本人の `email` が載ること | **仕様。判断待ち** | Auth.js の既定。他人のアドレスは含まれない。落とすなら1行 |

---

## 12. 変更ログ

- 2026-08-13 段階0〜2。DDL 15文を実行。Auth.js v5 を導入。**ログインの実機確認は認証情報待ち**
