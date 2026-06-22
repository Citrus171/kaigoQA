import { test, expect, type Page } from "@playwright/test";

// k3d 実機 E2E。api（Hono/docker/LLM/Postgres）は page.route でモックせず、
// port-forward 済みの本物 Service を叩く。検証対象 = 実機での認証→RAG→回答表示フルパス。
//
// 前提（手動セットアップ）:
//   kubectl port-forward -n kaigo svc/api 8787:8787 &
//   K3D_WEB_PORT=3456 kubectl port-forward -n kaigo svc/web 3456:3000 &
//   （K3D_WEB_PORT 省略時は 3456。playwright.k3d.config.ts が同 env を参照）
//   （apps/web/playwright.k3d.config.ts が webServer でこれらを reuseExistingServer として待つ）
//
// 検証方針:
//   - LLM 回答本文は非決定的のため、内容の正確性は検証しない。
//   - 認証フロー（httpOnly cookie）・リダイレクト保護・AiQaAnswer 構造フィールドの
//     存在と型・履歴 localStorage 保存・クリア を実機で検証する。
//   - seed アカウント demo@example.com / password を使用。

const HISTORY_KEY = "chat_history";

// 実機ログイン: ログインページの defaultValues（demo/password）で送信 → /chat へ。
// モックなし = BFF プロキシが Hono へ転送し httpOnly cookie をセットする。
async function loginAndGoChat(page: Page) {
  await page.goto("/login");
  await page.evaluate(() => localStorage.clear());
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL("**/chat", { timeout: 15_000 });
}

// 質問送信 → latest 回答セクションに「回答」heading 下の本文が現れるまで待つ。
// LLM 応答は最大30秒想定（RAG retrieval + cloud 生成）。
async function sendQuestion(page: Page, q: string) {
  await page.locator("textarea").fill(q);
  await page.getByRole("button", { name: "送信" }).click();
  await expect(
    page.locator("section", { has: page.getByRole("heading", { name: "回答" }) }),
  ).toBeVisible({ timeout: 60_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("/chat: k3d 実機（api モックなし）", () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test("実機ログインで /chat に遷移しフォームが表示される", async ({ page }) => {
    await loginAndGoChat(page);
    await expect(page.getByRole("heading", { name: "プロンプト Q&A" })).toBeVisible();
    await expect(page.locator("textarea")).toBeVisible();
    await expect(page.getByRole("button", { name: "送信" })).toBeVisible();
  });

  test("空入力では送信ボタンが disabled", async ({ page }) => {
    await loginAndGoChat(page);
    await expect(page.getByRole("button", { name: "送信" })).toBeDisabled();
    await page.locator("textarea").fill("   ");
    await expect(page.getByRole("button", { name: "送信" })).toBeDisabled();
    await page.locator("textarea").fill("介護保険の対象者は？");
    await expect(page.getByRole("button", { name: "送信" })).toBeEnabled();
  });

  test("実機 RAG で回答 + 補助情報が表示される（構造フィールド検証）", async ({ page }) => {
    await loginAndGoChat(page);
    await sendQuestion(page, "介護保険の対象者は誰ですか");

    const answerSection = page.locator("section", {
      has: page.getByRole("heading", { name: "回答" }),
    });

    // 回答本文は非空（LLM が何かしら返す）
    const answerText = page.getByTestId("answer-text");
    await expect(answerText).not.toBeEmpty();

    // 補助情報ラベル（実機で AiQaAnswer の全フィールドが UI に反映されるか）
    await expect(answerSection.getByText("tier")).toBeVisible();
    await expect(answerSection.getByText("route", { exact: true })).toBeVisible();
    await expect(answerSection.getByText("routeReason")).toBeVisible();
    await expect(answerSection.getByText("confidence")).toBeVisible();
    await expect(answerSection.getByText("model", { exact: true })).toBeVisible();
    await expect(answerSection.getByText("topScore")).toBeVisible();
    await expect(answerSection.getByText("latencyMs")).toBeVisible();
    await expect(answerSection.getByText("safety.disclaimer")).toBeVisible();
    await expect(answerSection.getByText("safety.escalatedByGuardrail")).toBeVisible();
    await expect(answerSection.getByText("safety.reasons")).toBeVisible();

    // route 値は knowledge_qa または escalate（capability-router の2分類）
    const routeRow = page.getByTestId("row-route");
    await expect(routeRow).toContainText(/knowledge_qa|escalate/);

    // tier 値は cloud または edge（AI_EDGE_PROVIDER=workersai だが cloud 生成前提）
    const tierRow = page.getByTestId("row-tier");
    await expect(tierRow).toContainText(/cloud|edge/);

    // sources: RAG がヒットしていれば1件以上。介護保険の対象者は core チャンクにあるため期待ヒット。
    await expect(answerSection.getByText(/sources \(\d+\)/)).toBeVisible();

    // confidence は 0-1 の数値（3桁固定小数）
    const confRow = page.getByTestId("row-confidence");
    await expect(confRow).toContainText(/\d\.\d{3}/);
  });

  test("実機回答が localStorage に履歴保存される", async ({ page }) => {
    await loginAndGoChat(page);
    await sendQuestion(page, "要介護認定の手続きを教えて");

    const items = await page.evaluate<{ question: string; answer: { answer: string } }[]>(() =>
      JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"),
    );
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0]!.question).toBe("要介護認定の手続きを教えて");
    expect(items[0]!.answer.answer.length).toBeGreaterThan(0);
  });

  test("複数送信で履歴が新しい順に表示される", async ({ page }) => {
    await loginAndGoChat(page);
    await sendQuestion(page, "訪問介護とは");
    await sendQuestion(page, "デイサービスとは");

    const historySection = page.locator("section", {
      has: page.getByRole("heading", { name: /過去の履歴/ }),
    });
    const items = historySection.locator("> ul > li");
    await expect(items).toHaveCount(2);
    // 新しい順: 1件目が「デイサービスとは」
    await expect(items.nth(0).getByText("デイサービスとは", { exact: true })).toBeVisible();
    await expect(items.nth(1).getByText("訪問介護とは", { exact: true })).toBeVisible();
  });

  test("履歴クリアボタンで localStorage と一覧が空になる", async ({ page }) => {
    await loginAndGoChat(page);
    await sendQuestion(page, "ショートステイの利用期間");
    await expect(
      page.locator("section", { has: page.getByRole("heading", { name: /過去の履歴/ }) }),
    ).toBeVisible();

    await page.getByRole("button", { name: "履歴クリア" }).click();

    await expect(page.getByRole("heading", { name: /過去の履歴/ })).toHaveCount(0);
    const raw = await page.evaluate<string | null>(() => localStorage.getItem(HISTORY_KEY));
    expect(raw).toBe("[]");
  });

  test("未認証で /chat にアクセスすると /login へリダイレクト（実機プロキシ）", async ({ page }) => {
    await page.goto("/chat");
    await page.waitForURL("**/login", { timeout: 10_000 });
    await expect(page).toHaveURL(/\/login$/);
  });

  test("ページ再読み込みで localStorage 履歴が復元される", async ({ page }) => {
    await loginAndGoChat(page);
    await sendQuestion(page, "福祉用具貸与の対象");
    await page.reload();
    await expect(
      page
        .locator("section", { has: page.getByRole("heading", { name: /過去の履歴/ }) })
        .getByText("福祉用具貸与の対象", { exact: true }),
    ).toBeVisible();
  });

  test("誤認証でログインエラー表示（実機で無効 credential を拒否）", async ({ page }) => {
    await page.goto("/login");
    await page.evaluate(() => localStorage.clear());
    await page.locator('input[type="email"]').fill("wrong@example.com");
    await page.locator('input[type="password"]').fill("wrongpass");
    await page.getByRole("button", { name: "ログイン" }).click();
    // 実機 Hono が 401 を返し BFF が {ok:false} に変換 → エラーメッセージ表示
    await expect(page.getByText(/メールアドレスまたはパスワードが違います/)).toBeVisible({ timeout: 10_000 });
    // /chat には遷移しない
    await expect(page).toHaveURL(/\/login$/);
  });
});
