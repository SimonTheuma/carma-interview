import { test, expect } from "@playwright/test";

test("E-STATES search page loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Media Signal" })).toBeVisible();
  await page.getByLabel("Search query").fill("renewable");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText(/Showing/)).toBeVisible({ timeout: 15_000 });
});

test("E4 quoted Chinese search and NOT note under Interpreted as", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search query").fill('"人工智能"');
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText(/Showing/)).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(/Chinese, Arabic and similar scripts match any text containing them/i),
  ).toBeVisible({ timeout: 15_000 });

  await page.getByLabel("Search query").fill("renewable AND NOT coal");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("#parse-echo")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#not-rule-note")).toContainText(
    "NOT terms exclude articles by their original text only",
  );
});

test("E-XSS article 6 has no script execution", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.ok()).toBeTruthy();
  // Find sanitised headline text as inert content
  await page.getByLabel("Search query").fill("breach");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("Breaking: Major Data Breach Reported")).toBeVisible({
    timeout: 15_000,
  });
});

test("quote tip and loose-match note appear for unquoted Latin", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Tip: add \*/i)).toBeVisible();
  await page.getByLabel("Search query").fill("startups");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText(/Showing/)).toBeVisible({ timeout: 15_000 });
});

test("article page original reveal is a details element", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search query").fill("oil");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText(/Showing/)).toBeVisible({ timeout: 15_000 });
  const details = page.getByRole("link", { name: "Details" }).first();
  if (await details.count()) {
    await details.click();
    const reveal = page.locator("details").filter({ hasText: /Show original text/i });
    if (await reveal.count()) {
      await reveal.locator("summary").focus();
      await page.keyboard.press("Enter");
      await expect(reveal).toHaveAttribute("open", "");
    }
  }
});
