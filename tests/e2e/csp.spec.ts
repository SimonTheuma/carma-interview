import { test, expect } from "@playwright/test";

const PAGES = ["/", "/trends", "/status", "/upload"] as const;

test.describe("E1–E3 CSP nonce and XSS samples", () => {
  test("E1 pages load with one nonce CSP and no violations", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (/content security policy|csp|refused to execute/i.test(text)) {
        violations.push(text);
      }
    });
    page.on("pageerror", (err) => {
      if (/content security policy|csp/i.test(err.message)) {
        violations.push(err.message);
      }
    });

    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        (window as unknown as { __cspViolations?: string[] }).__cspViolations ??= [];
        (window as unknown as { __cspViolations: string[] }).__cspViolations.push(
          `${e.violatedDirective}:${e.blockedURI}`,
        );
      });
    });

    for (const path of PAGES) {
      const res = await page.goto(path);
      expect(res?.ok(), path).toBeTruthy();
      const csp = res?.headers()["content-security-policy"] ?? "";
      expect(csp, path).toMatch(/nonce-/);
      expect(csp, path).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      expect((csp.match(/script-src/g) ?? []).length).toBe(1);

      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();
      // Browsers hide the nonce content attribute from the DOM API when CSP is
      // active, so we assert via header + no securitypolicyviolation events.
      await expect(page.locator("body")).toBeVisible();

      const pageViolations = await page.evaluate(
        () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
      );
      // Blocked `eval` is expected under production CSP (no 'unsafe-eval'); that is
      // the policy working. Fail on anything else (inline script, unexpected hosts).
      const surprising = pageViolations.filter((v) => v !== "script-src:eval");
      expect(surprising, path).toEqual([]);
    }

    const surprisingConsole = violations.filter((v) => !/eval/i.test(v));
    expect(surprisingConsole).toEqual([]);
  });

  test("E2 sample articles 6 and 18 keep injection inert", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Search query").fill("breach");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText("Breaking: Major Data Breach Reported")).toBeVisible({
      timeout: 15_000,
    });
    const pwned6 = await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned);
    expect(pwned6).toBeUndefined();

    await page.getByLabel("Search query").fill('"Food Delivery"');
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText(/Food Delivery Platform/i).first()).toBeVisible({
      timeout: 15_000,
    });
    const pwned18 = await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned);
    expect(pwned18).toBeUndefined();

    const details = page.getByRole("link", { name: "Details" }).first();
    await details.click();
    await expect(page.getByText(/vigorously/i).first()).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
  });

  test("E3 inline style attributes still apply", async ({ page }) => {
    await page.goto("/status");
    const bar = page.locator("div.h-full.bg-accent").first();
    if (await bar.count()) {
      const width = await bar.evaluate((el) => getComputedStyle(el).width);
      expect(width).not.toBe("");
      expect(width).not.toBe("0px");
    }

    await page.goto("/trends");
    const swatch = page.locator("[style*='background']").first();
    if (await swatch.count()) {
      const bg = await swatch.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe("");
      expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    }
  });
});
