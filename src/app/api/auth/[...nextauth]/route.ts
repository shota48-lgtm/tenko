// Auth.js の入口（ログイン・コールバック・ログアウト・セッションの取得）。
// 中身は src/auth.ts が持つ。ここは繋ぐだけ
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
