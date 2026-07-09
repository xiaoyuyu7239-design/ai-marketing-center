import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "@backend/shared/utils";

const wheatMaskStyle: CSSProperties = {
  WebkitMask: 'url("/brand-wheat.png") center / contain no-repeat',
  mask: 'url("/brand-wheat.png") center / contain no-repeat',
};

export function BrandWheatMark({ className, style, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      aria-hidden="true"
      className={cn("block bg-current", className)}
      style={{ ...wheatMaskStyle, ...style }}
      {...props}
    />
  );
}
