import { test, expect, type Page, type Route } from "@playwright/test";
import type { AiQaAnswer } from "@hybrid/shared";

// /chat の E2E。api（Hono/docker/LLM）は page.route でモックし、web サーバー単独で検証する。
// 検証対象 = /chat の UI 動作（入力/送信/回答+補助情報全表示/履歴20件/クリア/401遷移）。
// LLM 回答の中身は検証対象外（モック固定値）。

const HISTORY_KEY = "chat_history";

// aiQaAnswerSchema に準拠した固定モック回答。補助情報全表示の検証に全フィールドを使う。
const mockAnswer: AiQaAnswer = {
  answer: "これはモック回答です。",
  tier: "edge",
  route: "knowledge_qa",
  routeReason: "制度説明のため",
  confidence: 0.85,
  model: "mock:model-x",
  sources: [{ srcId: "doc-1", score: 0.9, excerpt: "要介護2の区分支給限度基準額は19,705単位/月です。" }],
  safety: { disclaimer: true, escalatedByGuardrail: false, reasons: [] },
  topScore: 0.72,
  latencyMs: 123,
};

// /api/auth/login をモック: {ok:true} + httpOnly cookie をセット（BFF の挙動をシミュレート）。
async function mockLogin(page: Page) {
  await page.route("**/api/auth/login", async (route: Route) => {
    await route.fulfill({
      status: 200,
      headers: { "Set-Cookie": "session=mock-jwt; Path=/; HttpOnly; SameSite=Lax" },
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
}

// /api/ai/qa をモック。req の質問を回答に反映して latest と履歴を区別できるようにする。
async function mockQaOk(page: Page) {
  await page.route("**/api/ai/qa", async (route: Route) => {
    const req = (await route.request().postDataJSON()) as { question: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...mockAnswer, answer: `回答: ${req.question}` }),
    });
  });
}

// /api/ai/qa が 401 を返すモック（認証切れのシミュレート）。
async function mockQa401(page: Page) {
  await page.route("**/api/ai/qa", async (route: Route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ message: "認証が必要です" }),
    });
  });
}

// ログインフォームを送信して /chat へ遷移。login ページは defaultValues 済み。
async function loginAndGoChat(page: Page) {
  await page.goto("/login");
  // 前テストの localStorage 履歴が /chat のマウント時読み込みに影響しないよう、ここで掃除。
  await page.evaluate(() => localStorage.clear());
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL("**/chat");
}

// テキストエリアに質問を入力して送信し、latest の「回答」セクションに反映されるまで待つ。
async function sendQuestion(page: Page, q: string) {
  await page.locator("textarea").fill(q);
  await page.getByRole("button", { name: "送信" }).click();
  // latest の回答セクションに「回答: <q>」が現れるまで待つ（履歴にも同名が出るため heading 直下で絞る）。
  await expect(
    page.locator("section", { has: page.getByRole("heading", { name: "回答" }) }).getByText(`回答: ${q}`),
  ).toBeVisible();
}

test.beforeEach(async ({ page, context }) => {
  await context.clearCookies();
  await mockLogin(page);
});

test.describe("/chat: プロンプトQ&A", () => {
  test("ログイン成功で /chat に遷移しフォームが表示される", async ({ page }) => {
    await loginAndGoChat(page);
    await expect(page.getByRole("heading", { name: "プロンプト Q&A" })).toBeVisible();
    await expect(page.locator("textarea")).toBeVisible();
    await expect(page.getByRole("button", { name: "送信" })).toBeVisible();
  });

  test("空入力では送信ボタンが disabled", async ({ page }) => {
    await loginAndGoChat(page);
    await expect(page.getByRole("button", { name: "送信" })).toBeDisabled();
    await page.locator("textarea").fill("  ");
    await expect(page.getByRole("button", { name: "送信" })).toBeDisabled();
    await page.locator("textarea").fill("何か書いた");
    await expect(page.getByRole("button", { name: "送信" })).toBeEnabled();
  });

  test("送信すると回答 + 補助情報が全て表示される", async ({ page }) => {
    await mockQaOk(page);
    await loginAndGoChat(page);
    await sendQuestion(page, "自己負担割合は？");

    const answerSection = page.locator("section", {
      has: page.getByRole("heading", { name: "回答" }),
    });
    // 回答本文
    await expect(answerSection.getByText("回答: 自己負担割合は？")).toBeVisible();
    // 補助情報: 全ラベルと値
    await expect(answerSection.getByText("tier")).toBeVisible();
    await expect(answerSection.getByText("edge", { exact: true })).toBeVisible();
    await expect(answerSection.getByText("route", { exact: true })).toBeVisible();
    await expect(answerSection.getByText("knowledge_qa")).toBeVisible();
    await expect(answerSection.getByText("routeReason")).toBeVisible();
    await expect(answerSection.getByText("制度説明のため")).toBeVisible();
    await expect(answerSection.getByText("confidence")).toBeVisible();
    await expect(answerSection.getByText("0.850")).toBeVisible();
    await expect(answerSection.getByText("model", { exact: true })).toBeVisible();
    await expect(answerSection.getByText("mock:model-x")).toBeVisible();
    await expect(answerSection.getByText("topScore")).toBeVisible();
    await expect(answerSection.getByText("0.720")).toBeVisible();
    await expect(answerSection.getByText("latencyMs")).toBeVisible();
    await expect(answerSection.getByText("123 ms")).toBeVisible();
    await expect(answerSection.getByText("safety.disclaimer")).toBeVisible();
    await expect(answerSection.getByText("safety.escalatedByGuardrail")).toBeVisible();
    await expect(answerSection.getByText("safety.reasons")).toBeVisible();
    // sources
    await expect(answerSection.getByText("sources (1)")).toBeVisible();
    await expect(answerSection.getByText(/doc-1/)).toBeVisible();
    await expect(answerSection.getByText(/要介護2の区分支給限度基準額/)).toBeVisible();
  });

  test("送信結果が localStorage に履歴として保存される", async ({ page }) => {
    await mockQaOk(page);
    await loginAndGoChat(page);
    await sendQuestion(page, "保存される質問");

    const items = await page.evaluate<unknown[]>(() =>
      JSON.parse(localStorage.getItem("chat_history") ?? "[]"),
    );
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(1);
    const first = items[0] as { question: string; answer: { answer: string } };
    expect(first.question).toBe("保存される質問");
    expect(first.answer.answer).toBe("回答: 保存される質問");
  });

  test("履歴一覧が新しい順で表示される", async ({ page }) => {
    await mockQaOk(page);
    await loginAndGoChat(page);
    await sendQuestion(page, "古い質問");
    await sendQuestion(page, "新しい質問");

    const historySection = page.locator("section", {
      has: page.getByRole("heading", { name: /過去の履歴/ }),
    });
    const items = historySection.locator("> ul > li");
    await expect(items).toHaveCount(2);
    // 新しい順: 1件目が「新しい質問」
    await expect(items.nth(0).getByText("新しい質問", { exact: true })).toBeVisible();
    await expect(items.nth(1).getByText("古い質問", { exact: true })).toBeVisible();
  });

  test("履歴は最新20件に制限される（21件送信で20件保持・最古は破棄）", async ({ page }) => {
    await mockQaOk(page);
    await loginAndGoChat(page);

    for (let i = 1; i <= 21; i++) {
      await sendQuestion(page, `質問${i}`);
    }

    const items = await page.evaluate<{ question: string }[]>(() =>
      JSON.parse(localStorage.getItem("chat_history") ?? "[]"),
    );
    expect(items).toHaveLength(20);
    // 新しい順なので先頭=質問21、末尾=質問2、質問1(最古)は破棄。
    expect(items[0]!.question).toBe("質問21");
    expect(items[19]!.question).toBe("質問2");
    expect(items.map((it) => it.question)).not.toContain("質問1");

    // 一覧表示も20件
    const historySection = page.locator("section", {
      has: page.getByRole("heading", { name: /過去の履歴/ }),
    });
    await expect(historySection.locator("> ul > li")).toHaveCount(20);
    // 見出しに「最新20件」と表示
    await expect(historySection.getByRole("heading", { name: /最新20件/ })).toBeVisible();
  });

  test("履歴クリアボタンで localStorage と一覧が空になる", async ({ page }) => {
    await mockQaOk(page);
    await loginAndGoChat(page);
    await sendQuestion(page, "消される質問");
    await expect(
      page.locator("section", { has: page.getByRole("heading", { name: /過去の履歴/ }) }),
    ).toBeVisible();

    await page.getByRole("button", { name: "履歴クリア" }).click();

    // 履歴一覧セクションが消える
    await expect(
      page.getByRole("heading", { name: /過去の履歴/ }),
    ).toHaveCount(0);
    // localStorage も空
    const raw = await page.evaluate<string | null>(() => localStorage.getItem("chat_history"));
    expect(raw).toBe("[]");
  });

  test("/ai/qa が 401 を返すと /login へリダイレクトする", async ({ page }) => {
    await mockQa401(page);
    await loginAndGoChat(page);
    await page.locator("textarea").fill("認証切れテスト");
    await page.getByRole("button", { name: "送信" }).click();
    await page.waitForURL("**/login");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("/ は /chat へリダイレクトする", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL("**/chat");
    await expect(page).toHaveURL(/\/chat$/);
  });

  test("ページ再読み込みで localStorage の履歴が復元される", async ({ page }) => {
    await mockQaOk(page);
    await loginAndGoChat(page);
    await sendQuestion(page, "復元される質問");
    await page.reload();
    // マウント時の useEffect で localStorage 読み込み → 履歴一覧に再表示
    await expect(
      page
        .locator("section", { has: page.getByRole("heading", { name: /過去の履歴/ }) })
        .getByText("復元される質問", { exact: true }),
    ).toBeVisible();
  });
});
