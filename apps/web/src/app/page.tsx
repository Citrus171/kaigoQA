import { redirect } from "next/navigation";

export default function Home() {
  // 認証はクライアント側（/todos が 401 なら /login へ）で扱う。
  redirect("/todos");
}
