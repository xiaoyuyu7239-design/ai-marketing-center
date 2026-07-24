"use client";

export type BatchGenerationKind = "image" | "video";

export function newGenerationOperationId(kind: `${BatchGenerationKind}-batch` | `${BatchGenerationKind}-single`) {
  return `${kind}:${crypto.randomUUID()}`;
}

/** 批量按钮必须先让服务端冻结完整 manifest；成功后才能并发启动逐项供应商调用。 */
export async function createBatchGenerationOperation(input: {
  projectId: string;
  kind: BatchGenerationKind;
  operationId: string;
  itemKeys: string[];
}) {
  const response = await fetch("/api/generation/operations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "创建批量生成任务失败");
  }
  return data as {
    operationId: string;
    status: "reserved" | "running" | "succeeded" | "partial" | "failed";
    expectedItems: number;
    completedItems: number;
    succeededItems: number;
    failedItems: number;
    duplicate: boolean;
  };
}
