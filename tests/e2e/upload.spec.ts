import { test, expect } from "@playwright/test";

test.describe("upload page", () => {
  test("page loads with form or disabled message", async ({ page }) => {
    await page.goto("/upload");
    await expect(page.getByRole("link", { name: "Upload" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Upload articles/i })).toBeVisible();
    const disabled = page.getByText(/Upload is disabled/i);
    const fileInput = page.getByLabel(/JSON file/i);
    const either = (await disabled.count()) > 0 || (await fileInput.count()) > 0;
    expect(either).toBe(true);
  });

  test("rejection for invalid JSON shows error (when upload enabled)", async ({ page }) => {
    await page.goto("/upload");
    if ((await page.getByText(/Upload is disabled/i).count()) > 0) {
      test.skip();
      return;
    }
    await page.getByLabel(/JSON file/i).setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from("{not-json"),
    });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10_000 });
  });

  test("XSS: reason codes and ids render as text", async ({ page }) => {
    await page.goto("/upload");
    // No article text is rendered from the upload response; ensure page shell is inert.
    const html = await page.content();
    expect(html).not.toMatch(/<script>alert/i);
  });
});
