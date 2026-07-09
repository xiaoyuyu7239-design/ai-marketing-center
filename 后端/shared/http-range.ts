// HTTP Range header parsing for media file routes (single-range "bytes=" forms only).

export interface ByteRange {
  start: number;
  end: number;
}

export function parseRangeHeader(
  header: string | null | undefined,
  size: number
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "unsatisfiable";

  const [, startStr, endStr] = match;
  if (!startStr && !endStr) return "unsatisfiable";
  if (size <= 0) return "unsatisfiable";

  if (!startStr) {
    const suffixLength = Number(endStr);
    if (suffixLength === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(startStr);
  const end = endStr ? Number(endStr) : size - 1;

  if (start >= size) return "unsatisfiable";
  if (start > end) return "unsatisfiable";

  return { start, end: Math.min(end, size - 1) };
}
