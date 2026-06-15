// pg-boss / Inngest 相当のジョブ投入ポイント。
// Workers では Cloudflare Queues や Inngest(HTTP) に差し替える。
// ローカル/PoC ではログ出力に留め、失敗してもリクエストを止めない（ベストエフォート）。
export async function dispatchTodoCreated(todo: {
  id: string;
  title: string;
  userId: string;
}): Promise<void> {
  try {
    console.log(
      `[job] todo.created id=${todo.id} title="${todo.title}" user=${todo.userId}`,
    );
  } catch (e) {
    console.warn("[job] dispatch skipped:", e);
  }
}
