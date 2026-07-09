import { redirect } from "next/navigation";

// 用户打开对外网页链接时先进入落地页，再由首屏三角按钮进入创作界面。
export default function HomePage() {
  redirect("/start");
}
