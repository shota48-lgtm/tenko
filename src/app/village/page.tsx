// 旧URL。Phase 4.7 で村を / に移したため、ここは転送だけ行う。
// 既存のブックマークやリンクを壊さないために残している。
import { redirect } from "next/navigation";

export default function VillageRedirect() {
  redirect("/");
}
