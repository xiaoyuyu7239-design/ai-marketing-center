import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 数值转百分比字符串，precision 默认 1 位小数 */
export function fmtPct(value: number, precision = 1): string {
  return `${(value * 100).toFixed(precision)}%`;
}

/** 从选项数组查找 label，找不到时回退到 value 本身 */
export function labelOf(opts: { value: string; label: string }[], v: string): string {
  return opts.find((o) => o.value === v)?.label ?? v;
}
