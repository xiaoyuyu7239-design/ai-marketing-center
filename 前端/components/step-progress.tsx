"use client";

import Link from "next/link";
import { LuArrowLeft } from "react-icons/lu";

/**
 * 项目四步工作流进度条 — script / assets / video / export 四页去重。
 * <StepProgressIndicator steps={[t("stepScript"), ...]} activeIndex={0} />
 */
export function StepProgressIndicator({
  steps,
  activeIndex,
  hrefs,
  backLabel = "返回上一步",
}: {
  steps: string[];
  activeIndex: number;
  hrefs?: string[];
  backLabel?: string;
}) {
  const activeLabel = steps[activeIndex] ?? steps[0] ?? "";
  const previousHref = activeIndex > 0 ? hrefs?.[activeIndex - 1] : undefined;

  return (
    <div className="flex items-center gap-2">
      {previousHref && (
        <Link
          href={previousHref}
          className="inline-flex h-8 items-center gap-1 rounded-full border border-border/70 bg-background px-2.5 text-xs font-semibold text-muted-foreground transition hover:border-foreground/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          aria-label={backLabel}
        >
          <LuArrowLeft className="h-3.5 w-3.5" />
          <span className="hidden md:inline">{backLabel}</span>
        </Link>
      )}
      <span className="rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground">
        {activeIndex + 1}/{steps.length} {activeLabel}
      </span>
      {steps.map((label, i) => {
        const isDone = i < activeIndex;
        const isActive = i === activeIndex;
        const href = hrefs?.[i];
        const canNavigateBack = Boolean(href) && isDone;
        const dot = (
          <span
            className={`h-2 w-2 rounded-full ${
              isDone || isActive ? "bg-primary" : "bg-muted"
            }`}
          />
        );

        return canNavigateBack && href ? (
          <Link
            key={label}
            href={href}
            title={label}
            aria-label={label}
            className="flex h-5 w-5 items-center justify-center rounded-full transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            {dot}
          </Link>
        ) : (
          <span
            key={label}
            title={label}
            className="flex h-5 w-5 items-center justify-center rounded-full"
          >
            {dot}
          </span>
        );
      })}
    </div>
  );
}
