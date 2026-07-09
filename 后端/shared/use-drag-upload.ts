"use client";

import { useState, useCallback } from "react";

/**
 * 共享拖拽上传 hook — agent / clone / products 三页去重。
 * 返回 isDragging 状态 + drag 事件处理器 + 高亮 className。
 */
export function useDragUpload(opts?: { ringClass?: string }) {
  const ring = opts?.ringClass ?? "ring-2 ring-primary/20 rounded-xl";
  const [isDragging, setIsDragging] = useState(false);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const dragClass = isDragging ? ring : "";

  return { isDragging, dragHandlers: { onDragOver, onDragLeave, onDrop }, dragClass };
}
