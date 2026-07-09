import { test, expect } from "@playwright/test";

test.describe("冒烟测试", () => {
  test("网页链接先进入落地页，点击三角标进入创作界面", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("daihuo-jianshou-settings", JSON.stringify({ state: { locale: "zh", localeSource: "user" }, version: 0 }));
    });

    await page.goto("/");
    const startCta = page.locator('a[href="/project/agent"]');
    await expect(page).toHaveURL(/\/start$/);
    await expect(page.locator("video.cf-bg-video")).toBeVisible();
    await expect(startCta).toContainText("一键绘成 即刻成片");

    await startCta.click();
    await expect(page).toHaveURL(/\/project\/agent$/);
    await expect(page.getByRole("heading", { name: "一键绘成，即刻开卖" })).toBeVisible();
  });

  test("商品库页面可以加载", async ({ page }) => {
    await page.goto("/products");
    await expect(page.locator("text=商品库")).toBeVisible();
  });

  test("新建项目流程可以到达表单", async ({ page }) => {
    await page.goto("/project/new");
    await expect(page.locator("text=商品图片")).toBeVisible();
    await expect(page.locator("text=商品名称")).toBeVisible();
    await expect(page.locator("text=视频模式")).toBeVisible();
  });

  test("设置页可以切换 Tab", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator("text=AI 平台")).toBeVisible();
    await page.click("text=出镜人物");
    await expect(page.locator("text=添加出镜人物")).toBeVisible();
    await page.click("text=品牌设置");
    await expect(page.locator("text=店铺名称")).toBeVisible();
  });

  test("批量出片页面可以加载", async ({ page }) => {
    await page.goto("/batch");
    await expect(page.locator("text=批量出片")).toBeVisible();
  });
});
