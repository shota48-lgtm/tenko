// セッションに載せる tenko 固有の情報の型。
// id は数値。pg が bigint を文字列で返すため、auth.ts の session コールバックで Number() に通している
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: number;
      displayName: string;
      // 表示の分岐にだけ使う。権限の判定は必ずAPI側で users を引き直して行う
      role: string;
    } & DefaultSession["user"];
  }
}
