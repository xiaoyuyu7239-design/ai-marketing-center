"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageCircleQuestion } from "lucide-react";

export function BetaSupportLink() {
  const pathname = usePathname();
  if (pathname.startsWith("/admin") || pathname.startsWith("/legal") || pathname === "/support") {
    return null;
  }

  return (
    <Link
      href="/support"
      className="fixed bottom-4 right-4 z-40 inline-flex h-10 items-center gap-2 rounded-full border border-black/10 bg-white/95 px-4 text-sm font-bold text-[#222] shadow-lg backdrop-blur transition hover:-translate-y-0.5 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#111]"
      aria-label="内测帮助与问题反馈"
    >
      <MessageCircleQuestion className="size-4" />
      内测帮助
    </Link>
  );
}
