import { expect, test } from "@playwright/test";
import { installDeterministicBinance } from "./binanceFixture";

test("recovers from persisted primitive preferences without a blank screen", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await installDeterministicBinance(page);
  await page.addInitScript(() => {
    localStorage.setItem("vf-chart-mode", JSON.stringify("footprint"));
    localStorage.setItem("vf-sidebar-width", JSON.stringify(420));
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.locator("#root .vf-app")).toBeVisible();
  await expect(page.getByText("VEILFLOW", { exact: true })).toBeVisible();
  await expect(page.locator(".vf-chart-panel-label").first()).toContainText("PRIMARY");
  expect(pageErrors).toEqual([]);
});
