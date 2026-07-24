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

  test("生成库存页面可以加载", async ({ page }) => {
    await page.goto("/products");
    await expect(page.getByRole("heading", { name: "生成库存" })).toBeVisible();
  });

  test("新建项目流程可以到达表单", async ({ page }) => {
    await page.goto("/project/new");
    await expect(page.locator("text=商品图片")).toBeVisible();
    await expect(page.locator("text=商品名称")).toBeVisible();
    await expect(page.locator("text=视频模式")).toBeVisible();
  });

  test("设置页只展示已接入用户链路的偏好", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "店铺与创作偏好" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "商家信息" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "发布提醒" })).toBeVisible();
    await expect(page.getByText("生成策略由工作人员统一维护")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "出镜人物" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "品牌设置" })).toHaveCount(0);
  });

  test("批量出片页面可以加载", async ({ page }) => {
    await page.goto("/batch");
    await expect(page.locator("text=批量出片")).toBeVisible();
  });
});
