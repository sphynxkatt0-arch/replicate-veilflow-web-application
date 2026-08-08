import { expect, test } from "@playwright/test";
import { installDeterministicBinance } from "./binanceFixture";

test("mobile chart uses performance-safe rendering and interaction defaults", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "Mobile-only performance regression coverage");
  const diagnostics: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") diagnostics.push(`console:${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.message}`));
  await installDeterministicBinance(page);

  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  const app = page.locator("#root .vf-app");
  try {
    await expect(app).toBeVisible({ timeout: 20_000 });
  } catch (error) {
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 1200);
    throw new Error([
      `Mobile application did not mount. status=${response?.status() ?? "none"} url=${page.url()} title=${await page.title()}`,
      ...diagnostics,
      `body=${body}`,
      error instanceof Error ? error.message : String(error),
    ].join("\n"));
  }

  await expect(page.locator("html")).toHaveClass(/vf-mobile-performance/);
  await expect(page.locator(".vf-chart-performance-shell")).toHaveClass(/vf-chart-performance-mobile/);

  const panels = page.locator(".vf-panel");
  await expect(panels.nth(0)).not.toHaveClass(/vf-collapsed/);
  await expect(panels.nth(1)).toHaveClass(/vf-collapsed/);
  await expect(panels.nth(2)).toHaveClass(/vf-collapsed/);

  const canvas = page.locator(".vf-chart-canvas");
  await expect(canvas).toBeVisible();
  await expect.poll(async () => page.evaluate(() => window.devicePixelRatio)).toBeLessThanOrEqual(1.25);
  await expect.poll(async () => canvas.evaluate((node) => {
    const element = node as HTMLCanvasElement;
    return element.clientWidth > 0 ? element.width / element.clientWidth : 99;
  })).toBeLessThanOrEqual(1.3);
  await expect(canvas).toHaveCSS("pointer-events", "none");

  const gestureToggle = page.getByRole("button", { name: "Enable chart gestures" });
  await expect(gestureToggle).toBeVisible();
  await gestureToggle.click();
  await expect(page.getByRole("button", { name: "Lock chart gestures" })).toBeVisible();
  await expect(canvas).toHaveCSS("pointer-events", "auto");

  const market = page.getByLabel("Market");
  await market.selectOption("BTCPERP");
  await expect(page.getByRole("heading", { name: /BTC \/ USDT Perpetual/i })).toBeVisible();
  await expect.poll(async () => (await page.locator(".vf-price strong").textContent())?.trim(), { timeout: 30_000 }).not.toBe("—");
});
