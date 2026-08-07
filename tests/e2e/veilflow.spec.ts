import { expect, test } from "@playwright/test";

async function expectLivePrice(page: import("@playwright/test").Page) {
  const price = page.locator(".vf-price strong");
  await expect(price).toBeVisible();
  await expect.poll(async () => (await price.textContent())?.trim(), { timeout: 30_000, message: "A live market price must arrive" }).not.toBe("—");
}

test("production-grade spot, perpetual, replay, and trust workflow", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#root .vf-app")).toBeVisible();
  await expect(page.getByText("VEILFLOW", { exact: true })).toBeVisible();

  const market = page.getByLabel("Market");
  const timeframe = page.getByLabel("Timeframe");
  await expect(market).toBeVisible();
  await expect(timeframe).toBeVisible();

  await market.selectOption("BTC");
  await expect(page.getByRole("heading", { name: /BTC \/ USDT Spot/i })).toBeVisible();
  await expectLivePrice(page);

  await timeframe.selectOption("15m");
  await expect(timeframe).toHaveValue("15m");
  await timeframe.selectOption("5m");
  await expect(timeframe).toHaveValue("5m");

  await market.selectOption("BTCPERP");
  await expect(page.getByRole("heading", { name: /BTC \/ USDT Perpetual/i })).toBeVisible();
  await expect(page.getByText("USDⓈ-M PERP", { exact: true })).toBeVisible();
  await expectLivePrice(page);

  await page.keyboard.press("2");
  await expect(page.getByRole("button", { name: /2 · footprint/i })).toHaveClass(/vf-active/);
  await page.keyboard.press("3");
  await expect(page.getByRole("button", { name: /3 · delta/i })).toHaveClass(/vf-active/);

  await page.keyboard.press("p");
  await expect(page.getByRole("dialog", { name: /trust, replay, and methodology/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Build identity" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Active provenance" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Candle reconciliation" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /trust, replay, and methodology/i })).toBeHidden();

  const openReplay = page.getByRole("button", { name: "Open Replay", exact: true });
  await expect(openReplay).toBeVisible();
  await openReplay.click();
  const replayCursor = page.getByLabel("Replay event cursor");
  await expect(replayCursor).toBeVisible();
  const maximum = Number(await replayCursor.getAttribute("max"));
  expect(maximum).toBeGreaterThan(0);
  const before = Number(await replayCursor.inputValue());
  await replayCursor.fill("0");
  await expect(replayCursor).toHaveValue("0");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => Number(await replayCursor.inputValue()), { timeout: 10_000 }).toBeGreaterThan(0);
  expect(Number(await replayCursor.inputValue())).not.toBe(before === 0 ? -1 : before);
  await page.getByRole("button", { name: "Return Live", exact: true }).click();
  await expect(openReplay).toBeVisible();

  await page.keyboard.press("s");
  await expect(page.getByRole("dialog", { name: /display, accessibility, and footprint/i })).toBeVisible();
  await page.getByText("Color palette").locator("../..").getByRole("combobox").selectOption("high-contrast");
  await expect(page.locator(".vf-app")).toHaveClass(/vf-palette-high-contrast/);
  await page.keyboard.press("Escape");

  if (consoleErrors.length || pageErrors.length) {
    await testInfo.attach("browser-errors", { body: [...consoleErrors, ...pageErrors].join("\n"), contentType: "text/plain" });
  }
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
