import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

export interface ProviderModelTelemetry {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Only an amount explicitly returned by the provider or billing layer. */
  costUsd?: number;
  /** Provider-returned model/deployment identifier, when present. */
  effectiveModel?: string;
}

type TelemetryReporter = (telemetry: ProviderModelTelemetry) => void;

const reporters = new AsyncLocalStorage<TelemetryReporter>();

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNonNegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Extract only supplier-reported usage/cost fields. Token pricing is deliberately
 * not inferred here because an alias, cache tier or negotiated price may differ.
 */
export function providerTelemetryFromPayload(payload: unknown): ProviderModelTelemetry | null {
  const root = record(payload);
  const usage = record(root.usage);
  const inputTokens = finiteNonNegative(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens);
  const outputTokens = finiteNonNegative(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens);
  const totalTokens = finiteNonNegative(usage.total_tokens ?? usage.totalTokens);
  const costUsd = finiteNonNegative(
    usage.cost_usd
      ?? usage.costUsd
      ?? root.cost_usd
      ?? root.costUsd
      ?? root.actual_cost_usd
      ?? root.actualCostUsd,
  );
  const effectiveModel = typeof root.model === "string" && root.model.trim()
    ? root.model.trim().slice(0, 300)
    : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined
    && costUsd === undefined && effectiveModel === undefined) {
    return null;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(effectiveModel !== undefined ? { effectiveModel } : {}),
  };
}

export function reportProviderModelPayload(payload: unknown) {
  const telemetry = providerTelemetryFromPayload(payload);
  if (telemetry) reporters.getStore()?.(telemetry);
}

/** Capture the current attempt so later ReadableStream pulls cannot lose async context. */
export function captureProviderModelPayloadReporter() {
  const reporter = reporters.getStore();
  return (payload: unknown) => {
    const telemetry = providerTelemetryFromPayload(payload);
    if (telemetry) reporter?.(telemetry);
  };
}

/** Bind model responses in this async operation to the corresponding run attempt. */
export function withModelTelemetryReporter<T>(reporter: TelemetryReporter, operation: () => T): T {
  return reporters.run(reporter, operation);
}
