import "server-only";

import {
  getGoldenCase,
  type AutomaticRubricCriterion,
  type CapabilityFamilyId,
  type EvaluationRequestKind,
  type GoldenAgentId,
  type GoldenCase,
  type HumanRubricCriterion,
  type JsonGoldenCase,
  type MediaGoldenCase,
  type RequiredShape,
} from "./golden-set";

export interface ShapeValidationIssue {
  path: string;
  code:
    | "type"
    | "required"
    | "unknown-key"
    | "min"
    | "max"
    | "length"
    | "pattern"
    | "literal"
    | "enum"
    | "union";
  message: string;
}

export interface CriterionScore {
  criterionId: string;
  label: string;
  weight: number;
  passed: boolean;
  detail?: string;
}

export interface JsonCaseScore {
  caseId: string;
  agentId: GoldenAgentId;
  evaluator: "automatic-json";
  parsed: boolean;
  structurePassed: boolean;
  qualityScore: number;
  criteria: CriterionScore[];
  issues: ShapeValidationIssue[];
  value: unknown;
}

export interface PendingMediaCaseScore {
  caseId: string;
  agentId: GoldenAgentId;
  evaluator: "human-media";
  structurePassed: null;
  qualityScore: null;
  humanReviewRequired: true;
  rubric: readonly HumanRubricCriterion[];
}

export type GoldenOutputScore = JsonCaseScore | PendingMediaCaseScore;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function charLength(value: string): number {
  return Array.from(value.trim()).length;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateShapeInto(value: unknown, shape: RequiredShape, path: string, issues: ShapeValidationIssue[]): void {
  if (shape.type === "union") {
    const valid = shape.variants.some((variant) => validateRequiredShape(value, variant, path).length === 0);
    if (!valid) issues.push({ path, code: "union", message: `${path} 不匹配任一允许结构` });
    return;
  }

  if (shape.type === "null") {
    if (value !== null) issues.push({ path, code: "type", message: `${path} 应为 null，实际为 ${typeName(value)}` });
    return;
  }

  if (shape.type === "literal") {
    if (!Object.is(value, shape.value)) issues.push({ path, code: "literal", message: `${path} 应为 ${JSON.stringify(shape.value)}` });
    return;
  }

  if (shape.type === "enum") {
    if (!shape.values.some((allowed) => Object.is(allowed, value))) {
      issues.push({ path, code: "enum", message: `${path} 不在允许值中` });
    }
    return;
  }

  if (shape.type === "string") {
    if (typeof value !== "string") {
      issues.push({ path, code: "type", message: `${path} 应为 string，实际为 ${typeName(value)}` });
      return;
    }
    const length = charLength(value);
    if (shape.minLength !== undefined && length < shape.minLength) {
      issues.push({ path, code: "length", message: `${path} 长度 ${length} 小于 ${shape.minLength}` });
    }
    if (shape.maxLength !== undefined && length > shape.maxLength) {
      issues.push({ path, code: "length", message: `${path} 长度 ${length} 大于 ${shape.maxLength}` });
    }
    if (shape.pattern !== undefined) {
      const pattern = new RegExp(shape.pattern, "u");
      if (!pattern.test(value)) issues.push({ path, code: "pattern", message: `${path} 不匹配 ${shape.pattern}` });
    }
    return;
  }

  if (shape.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push({ path, code: "type", message: `${path} 应为有限 number，实际为 ${typeName(value)}` });
      return;
    }
    if (shape.integer && !Number.isInteger(value)) issues.push({ path, code: "type", message: `${path} 应为整数` });
    if (shape.min !== undefined && value < shape.min) issues.push({ path, code: "min", message: `${path} 小于 ${shape.min}` });
    if (shape.max !== undefined && value > shape.max) issues.push({ path, code: "max", message: `${path} 大于 ${shape.max}` });
    return;
  }

  if (shape.type === "boolean") {
    if (typeof value !== "boolean") issues.push({ path, code: "type", message: `${path} 应为 boolean，实际为 ${typeName(value)}` });
    return;
  }

  if (shape.type === "array") {
    if (!Array.isArray(value)) {
      issues.push({ path, code: "type", message: `${path} 应为 array，实际为 ${typeName(value)}` });
      return;
    }
    if (shape.minItems !== undefined && value.length < shape.minItems) {
      issues.push({ path, code: "length", message: `${path} 数量 ${value.length} 小于 ${shape.minItems}` });
    }
    if (shape.maxItems !== undefined && value.length > shape.maxItems) {
      issues.push({ path, code: "length", message: `${path} 数量 ${value.length} 大于 ${shape.maxItems}` });
    }
    value.forEach((item, index) => validateShapeInto(item, shape.items, `${path}.${index}`, issues));
    return;
  }

  if (!isObject(value)) {
    issues.push({ path, code: "type", message: `${path} 应为 object，实际为 ${typeName(value)}` });
    return;
  }

  for (const [key, childShape] of Object.entries(shape.required)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      issues.push({ path: `${path}.${key}`, code: "required", message: `${path}.${key} 缺失` });
    } else {
      validateShapeInto(value[key], childShape, `${path}.${key}`, issues);
    }
  }

  for (const [key, childShape] of Object.entries(shape.optional ?? {})) {
    if (Object.prototype.hasOwnProperty.call(value, key)) validateShapeInto(value[key], childShape, `${path}.${key}`, issues);
  }

  if (!shape.allowUnknown) {
    const allowed = new Set([...Object.keys(shape.required), ...Object.keys(shape.optional ?? {})]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) issues.push({ path: `${path}.${key}`, code: "unknown-key", message: `${path}.${key} 是未约定字段` });
    }
  }
}

export function validateRequiredShape(value: unknown, shape: RequiredShape, path = "$"): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  validateShapeInto(value, shape, path, issues);
  return issues;
}

function pathSegments(path: string): string[] {
  if (path === "$" || path === "") return [];
  return path.replace(/^\$\.?/, "").split(".").filter(Boolean);
}

/** `*` 遍历数组/对象，`-1` 表示数组最后一项。 */
export function resolveValuesAtPath(root: unknown, path: string): unknown[] {
  let values: unknown[] = [root];
  for (const segment of pathSegments(path)) {
    const next: unknown[] = [];
    for (const value of values) {
      if (segment === "*") {
        if (Array.isArray(value)) next.push(...value);
        else if (isObject(value)) next.push(...Object.values(value));
        continue;
      }
      if (Array.isArray(value) && /^-?\d+$/.test(segment)) {
        const parsed = Number(segment);
        const index = parsed < 0 ? value.length + parsed : parsed;
        if (index >= 0 && index < value.length) next.push(value[index]);
        continue;
      }
      if (isObject(value) && Object.prototype.hasOwnProperty.call(value, segment)) next.push(value[segment]);
    }
    values = next;
  }
  return values;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return deepEqual(leftKeys, rightKeys) && leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

function stableKey(value: unknown): string {
  if (value === null || typeof value !== "object") return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${key}:${stableKey((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function valueLength(value: unknown): number | null {
  if (typeof value === "string") return charLength(value);
  if (Array.isArray(value)) return value.length;
  return null;
}

function readByField(value: unknown, field?: string): unknown {
  if (!field) return value;
  return resolveValuesAtPath(value, field)[0];
}

function checkCriterion(root: unknown, criterion: AutomaticRubricCriterion): CriterionScore {
  const { check } = criterion;
  const fail = (detail: string): CriterionScore => ({
    criterionId: criterion.id,
    label: criterion.label,
    weight: criterion.weight,
    passed: false,
    detail,
  });
  const pass = (): CriterionScore => ({
    criterionId: criterion.id,
    label: criterion.label,
    weight: criterion.weight,
    passed: true,
  });

  if (check.kind === "sum-equals-path") {
    const arrays = resolveValuesAtPath(root, check.arrayPath);
    const targets = resolveValuesAtPath(root, check.targetPath);
    if (arrays.length !== 1 || !Array.isArray(arrays[0]) || targets.length !== 1 || typeof targets[0] !== "number") {
      return fail("求和路径或目标路径不存在");
    }
    const values = arrays[0].map((item) => readByField(item, check.field));
    if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) return fail("求和字段含非数字");
    const total = (values as number[]).reduce((sum, value) => sum + value, 0);
    const tolerance = check.tolerance ?? 0;
    return Math.abs(total - targets[0]) <= tolerance ? pass() : fail(`求和 ${total} 不等于 ${targets[0]}`);
  }

  const values = resolveValuesAtPath(root, check.path);
  if (values.length === 0) return fail(`路径 ${check.path} 无值`);

  if (check.kind === "non-empty") {
    const ok = values.every((value) => {
      if (typeof value === "string") return charLength(value) > 0;
      if (Array.isArray(value)) return value.length > 0;
      if (isObject(value)) return Object.keys(value).length > 0;
      return value !== null && value !== undefined;
    });
    return ok ? pass() : fail("存在空值");
  }

  if (check.kind === "length") {
    const lengths = values.map(valueLength);
    if (lengths.some((length) => length === null)) return fail("目标不是字符串或数组");
    const ok = (lengths as number[]).every((length) =>
      (check.min === undefined || length >= check.min) && (check.max === undefined || length <= check.max));
    return ok ? pass() : fail(`长度为 ${lengths.join(",")}`);
  }

  if (check.kind === "equals") {
    return values.every((value) => deepEqual(value, check.value)) ? pass() : fail(`实际值 ${JSON.stringify(values)}`);
  }

  if (check.kind === "one-of") {
    return values.every((value) => check.values.some((allowed) => deepEqual(value, allowed))) ? pass() : fail("存在候选集外的值");
  }

  if (check.kind === "matches") {
    let pattern: RegExp;
    try {
      pattern = new RegExp(check.pattern, check.flags);
    } catch {
      return fail(`无效正则 ${check.pattern}`);
    }
    return values.every((value) => typeof value === "string" && pattern.test(value)) ? pass() : fail("存在不匹配的字符串");
  }

  if (check.kind === "unique") {
    if (!values.every(Array.isArray)) return fail("目标不是数组");
    const ok = values.every((array) => {
      const keys = array.map((item) => stableKey(readByField(item, check.by)));
      return new Set(keys).size === keys.length;
    });
    return ok ? pass() : fail("存在重复值");
  }

  if (check.kind === "set-equals") {
    const actual = values.map(stableKey).sort();
    const expected = check.values.map(stableKey).sort();
    return deepEqual(actual, expected) ? pass() : fail(`实际集合 ${JSON.stringify(values)}`);
  }

  if (check.kind === "excludes-terms") {
    const haystacks = values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).map((value) => value.toLocaleLowerCase());
    const found = check.terms.filter((term) => haystacks.some((value) => value.includes(term.toLocaleLowerCase())));
    return found.length === 0 ? pass() : fail(`命中禁用词: ${found.join(", ")}`);
  }

  if (check.kind === "number-range") {
    const ok = values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= check.min && value <= check.max);
    return ok ? pass() : fail(`实际值 ${JSON.stringify(values)}`);
  }

  return fail("未支持的评分规则");
}

function parseStrictJson(output: unknown): { parsed: true; value: unknown } | { parsed: false; error: string } {
  if (typeof output !== "string") return { parsed: true, value: output };
  const trimmed = output.trim();
  if (!trimmed) return { parsed: false, error: "输出为空" };
  try {
    return { parsed: true, value: JSON.parse(trimmed) };
  } catch (error) {
    return { parsed: false, error: error instanceof Error ? error.message : "JSON 解析失败" };
  }
}

function scoreJsonCase(goldenCase: JsonGoldenCase, output: unknown): JsonCaseScore {
  const parsed = parseStrictJson(output);
  if (!parsed.parsed) {
    return {
      caseId: goldenCase.id,
      agentId: goldenCase.agentId,
      evaluator: "automatic-json",
      parsed: false,
      structurePassed: false,
      qualityScore: 0,
      criteria: goldenCase.rubric.map((item) => ({
        criterionId: item.id,
        label: item.label,
        weight: item.weight,
        passed: false,
        detail: "JSON 未解析",
      })),
      issues: [{ path: "$", code: "type", message: parsed.error }],
      value: null,
    };
  }

  const issues = validateRequiredShape(parsed.value, goldenCase.requiredShape);
  const criteria = goldenCase.rubric.map((criterion) => checkCriterion(parsed.value, criterion));
  const weight = goldenCase.rubric.reduce((sum, item) => sum + item.weight, 0);
  const earned = criteria.reduce((sum, item) => sum + (item.passed ? item.weight : 0), 0);
  const structurePassed = issues.length === 0;

  return {
    caseId: goldenCase.id,
    agentId: goldenCase.agentId,
    evaluator: "automatic-json",
    parsed: true,
    structurePassed,
    // 结构合同不通过时不给“内容看起来不错”的安慰分。
    qualityScore: structurePassed && weight > 0 ? round((earned / weight) * 100, 4) : 0,
    criteria,
    issues,
    value: parsed.value,
  };
}

export function scoreGoldenOutput(caseOrId: GoldenCase | string, output: unknown): GoldenOutputScore {
  const goldenCase = typeof caseOrId === "string" ? getGoldenCase(caseOrId) : caseOrId;
  if (goldenCase.outputKind === "json") return scoreJsonCase(goldenCase, output);
  return {
    caseId: goldenCase.id,
    agentId: goldenCase.agentId,
    evaluator: "human-media",
    structurePassed: null,
    qualityScore: null,
    humanReviewRequired: true,
    rubric: goldenCase.rubric,
  };
}

export interface HumanMediaReviewInput {
  mediaType: "image" | "video" | "audio";
  artifactCount: number;
  /** 每项 1-5 分；缺项或越界时不会得出伪造的总分。 */
  scores: Readonly<Record<string, number>>;
}

export interface HumanMediaCaseScore {
  caseId: string;
  agentId: GoldenAgentId;
  evaluator: "human-media";
  artifactRequirementPassed: boolean;
  reviewComplete: boolean;
  qualityScore: number | null;
  criteria: Array<{
    criterionId: string;
    label: string;
    weight: number;
    score: number | null;
    weightedScore: number | null;
  }>;
  issues: string[];
}

export function scoreHumanMediaCase(caseOrId: MediaGoldenCase | string, review: HumanMediaReviewInput): HumanMediaCaseScore {
  const resolved = typeof caseOrId === "string" ? getGoldenCase(caseOrId) : caseOrId;
  if (resolved.outputKind !== "media") throw new Error(`Case ${resolved.id} 不是媒体任务`);

  const issues: string[] = [];
  if (!Number.isInteger(review.artifactCount) || review.artifactCount < 0) issues.push("artifactCount 必须是非负整数");
  if (review.mediaType !== resolved.requiredShape.mediaType) issues.push(`媒体类型应为 ${resolved.requiredShape.mediaType}`);
  const artifactRequirementPassed =
    review.mediaType === resolved.requiredShape.mediaType &&
    Number.isInteger(review.artifactCount) &&
    review.artifactCount >= resolved.requiredShape.minimumArtifacts;
  if (!artifactRequirementPassed) issues.push(`至少需要 ${resolved.requiredShape.minimumArtifacts} 个可审核产物`);

  const rubricIds = new Set(resolved.rubric.map((item) => item.id));
  for (const scoreId of Object.keys(review.scores)) {
    if (!rubricIds.has(scoreId)) issues.push(`未知评分项: ${scoreId}`);
  }

  const criteria = resolved.rubric.map((criterion) => {
    const value = review.scores[criterion.id];
    const valid = typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 5;
    if (!valid) issues.push(`${criterion.id} 需要 1-5 分`);
    return {
      criterionId: criterion.id,
      label: criterion.label,
      weight: criterion.weight,
      score: valid ? value : null,
      weightedScore: valid ? criterion.weight * (value / 5) : null,
    };
  });

  const reviewComplete = artifactRequirementPassed && criteria.every((item) => item.score !== null) && issues.length === 0;
  const weightedTotal = criteria.reduce((sum, item) => sum + (item.weightedScore ?? 0), 0);
  const totalWeight = criteria.reduce((sum, item) => sum + item.weight, 0);

  return {
    caseId: resolved.id,
    agentId: resolved.agentId,
    evaluator: "human-media",
    artifactRequirementPassed,
    reviewComplete,
    qualityScore: reviewComplete && totalWeight > 0 ? round((weightedTotal / totalWeight) * 100, 4) : null,
    criteria,
    issues,
  };
}

export interface GoldenTrialResult {
  /** 同一个 provider/model/endpoint 版本必须使用同一稳定 key。 */
  candidateKey: string;
  caseId: string;
  runId: string;
  success: boolean;
  structurePassed: boolean | null;
  qualityScore: number | null;
  latencyMs: number;
  /** 只接收供应商返回/按真实 token 用量计算的成本；未取得必须是 null。 */
  actualCostUsd: number | null;
}

export interface PromotionMetrics {
  candidateKey: string;
  agentId: GoldenAgentId;
  familyId: CapabilityFamilyId;
  sampleCount: number;
  /** 同一 case 重复运行只算一个用例，不得用重试伪造 Golden 覆盖。 */
  distinctCaseCount: number;
  successRate: number;
  structureSampleCount: number;
  structurePassRate: number | null;
  qualitySampleCount: number;
  qualityCoverageRate: number;
  qualityScore: number | null;
  p95LatencyMs: number;
  costSampleCount: number;
  costCoverageRate: number;
  /** 只要有一条成本缺失，总成本和平均成本都保持 null，不把部分成本伪装成全量。 */
  totalActualCostUsd: number | null;
  averageActualCostUsd: number | null;
}

function assertRate(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} 必须在 0-1 之间`);
}

function assertTrial(trial: GoldenTrialResult): GoldenCase {
  if (!trial.candidateKey.trim()) throw new Error("candidateKey 不能为空");
  if (!trial.runId.trim()) throw new Error("runId 不能为空");
  if (!Number.isFinite(trial.latencyMs) || trial.latencyMs < 0) throw new Error("latencyMs 必须是非负有限数");
  if (trial.qualityScore !== null && (!Number.isFinite(trial.qualityScore) || trial.qualityScore < 0 || trial.qualityScore > 100)) {
    throw new Error("qualityScore 必须在 0-100 之间或为 null");
  }
  if (trial.actualCostUsd !== null && (!Number.isFinite(trial.actualCostUsd) || trial.actualCostUsd < 0)) {
    throw new Error("actualCostUsd 必须是非负有限数或为 null");
  }
  return getGoldenCase(trial.caseId);
}

function weightedMean(items: readonly { value: number; weight: number }[]): number | null {
  if (items.length === 0) return null;
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return null;
  return items.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
}

/** 最近秩 P95：排序后取 ceil(0.95*n) 位，小样本不做插值美化。 */
export function percentile95(values: readonly number[]): number {
  if (values.length === 0) throw new Error("计算 P95 至少需要一个样本");
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("P95 样本必须是非负有限数");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

/** 必须按单一 Agent + 单一候选模型聚合，确保“按任务验收”。 */
export function aggregatePromotionMetrics(trials: readonly GoldenTrialResult[]): PromotionMetrics {
  if (trials.length === 0) throw new Error("至少需要一条评测结果");

  const resolved = trials.map((trial) => ({ trial, goldenCase: assertTrial(trial) }));
  const candidateKey = trials[0].candidateKey;
  const agentId = resolved[0].goldenCase.agentId;
  const familyId = resolved[0].goldenCase.familyId;

  if (resolved.some((item) => item.trial.candidateKey !== candidateKey)) throw new Error("不得混合多个候选模型的结果");
  if (resolved.some((item) => item.goldenCase.agentId !== agentId)) throw new Error("不得混合多个 Agent 的结果；必须按任务单独验收");
  if (new Set(trials.map((trial) => trial.runId)).size !== trials.length) throw new Error("runId 重复");

  const weighted = resolved.map((item) => ({ ...item, weight: item.goldenCase.weight }));
  const successRate = weightedMean(weighted.map((item) => ({ value: item.trial.success ? 1 : 0, weight: item.weight }))) ?? 0;
  const structure = weighted.filter((item) => item.trial.structurePassed !== null);
  const quality = weighted.filter((item) => item.trial.qualityScore !== null);
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  const qualityWeight = quality.reduce((sum, item) => sum + item.weight, 0);
  const priced = trials.filter((trial) => trial.actualCostUsd !== null);
  const completeCost = priced.length === trials.length;
  const totalActualCostUsd = completeCost
    ? round(priced.reduce((sum, trial) => sum + (trial.actualCostUsd as number), 0), 8)
    : null;

  return {
    candidateKey,
    agentId,
    familyId,
    sampleCount: trials.length,
    distinctCaseCount: new Set(trials.map((trial) => trial.caseId)).size,
    successRate: round(successRate, 6),
    structureSampleCount: structure.length,
    structurePassRate: structure.length === 0
      ? null
      : round(weightedMean(structure.map((item) => ({ value: item.trial.structurePassed ? 1 : 0, weight: item.weight }))) ?? 0, 6),
    qualitySampleCount: quality.length,
    qualityCoverageRate: round(totalWeight > 0 ? qualityWeight / totalWeight : 0, 6),
    qualityScore: quality.length === 0
      ? null
      : round(weightedMean(quality.map((item) => ({ value: item.trial.qualityScore as number, weight: item.weight }))) as number, 4),
    p95LatencyMs: percentile95(trials.map((trial) => trial.latencyMs)),
    costSampleCount: priced.length,
    costCoverageRate: round(priced.length / trials.length, 6),
    totalActualCostUsd,
    averageActualCostUsd: totalActualCostUsd === null ? null : round(totalActualCostUsd / trials.length, 8),
  };
}

export interface PromotionThresholds {
  minSamples: number;
  minDistinctCases: number;
  minSuccessRate: number;
  /** 媒体任务没有 JSON 结构率，设 null 表示不适用。 */
  minStructurePassRate: number | null;
  minQualityCoverageRate: number;
  minQualityScore: number;
  maxP95LatencyMs: number;
  /** 真实账单成本覆盖率；媒体内测必须为 1。 */
  minCostCoverageRate: number;
  /** 为 true 时，未配置成本上限本身就是发布阻断。 */
  requireCostLimit: boolean;
  /** 未配置成本上限时设 null；一旦配置，成本数据不全必须阻止晋级。 */
  maxAverageActualCostUsd: number | null;
}

function envCostLimit(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export const INVITE_BETA_PROMOTION_THRESHOLDS: Readonly<Record<EvaluationRequestKind, PromotionThresholds>> = {
  "chat-json": {
    minSamples: 3,
    minDistinctCases: 3,
    minSuccessRate: 0.95,
    minStructurePassRate: 0.95,
    minQualityCoverageRate: 1,
    minQualityScore: 80,
    maxP95LatencyMs: 15_000,
    minCostCoverageRate: 0,
    requireCostLimit: false,
    maxAverageActualCostUsd: null,
  },
  "vision-json": {
    minSamples: 3,
    minDistinctCases: 3,
    minSuccessRate: 0.95,
    minStructurePassRate: 0.95,
    minQualityCoverageRate: 1,
    minQualityScore: 85,
    maxP95LatencyMs: 20_000,
    minCostCoverageRate: 0,
    requireCostLimit: false,
    maxAverageActualCostUsd: null,
  },
  "image-generation": {
    minSamples: 3,
    minDistinctCases: 3,
    minSuccessRate: 0.9,
    minStructurePassRate: null,
    minQualityCoverageRate: 1,
    minQualityScore: 80,
    maxP95LatencyMs: 120_000,
    minCostCoverageRate: 1,
    requireCostLimit: true,
    maxAverageActualCostUsd: envCostLimit("HUIMAI_EVAL_MAX_IMAGE_COST_USD"),
  },
  "video-generation": {
    minSamples: 3,
    minDistinctCases: 3,
    minSuccessRate: 0.9,
    minStructurePassRate: null,
    minQualityCoverageRate: 1,
    minQualityScore: 75,
    maxP95LatencyMs: 600_000,
    minCostCoverageRate: 1,
    requireCostLimit: true,
    maxAverageActualCostUsd: envCostLimit("HUIMAI_EVAL_MAX_VIDEO_COST_USD"),
  },
  "tts-generation": {
    minSamples: 3,
    minDistinctCases: 3,
    minSuccessRate: 0.95,
    minStructurePassRate: null,
    minQualityCoverageRate: 1,
    minQualityScore: 80,
    maxP95LatencyMs: 30_000,
    minCostCoverageRate: 1,
    requireCostLimit: true,
    maxAverageActualCostUsd: envCostLimit("HUIMAI_EVAL_MAX_TTS_COST_USD"),
  },
};

export type PromotionFailureCode =
  | "samples"
  | "distinct-cases"
  | "success-rate"
  | "structure-unavailable"
  | "structure-rate"
  | "quality-coverage"
  | "quality-unavailable"
  | "quality-score"
  | "latency"
  | "cost-coverage"
  | "cost-threshold-unconfigured"
  | "cost-unavailable"
  | "cost";

export interface PromotionFailure {
  code: PromotionFailureCode;
  message: string;
  actual: number | null;
  required: number;
}

export interface PromotionDecision {
  passed: boolean;
  failures: PromotionFailure[];
}

export function evaluatePromotion(metrics: PromotionMetrics, thresholds: PromotionThresholds): PromotionDecision {
  if (!Number.isInteger(thresholds.minSamples) || thresholds.minSamples < 1) throw new Error("minSamples 必须是正整数");
  if (!Number.isInteger(thresholds.minDistinctCases) || thresholds.minDistinctCases < 1) {
    throw new Error("minDistinctCases 必须是正整数");
  }
  assertRate("minSuccessRate", thresholds.minSuccessRate);
  if (thresholds.minStructurePassRate !== null) assertRate("minStructurePassRate", thresholds.minStructurePassRate);
  assertRate("minQualityCoverageRate", thresholds.minQualityCoverageRate);
  assertRate("minCostCoverageRate", thresholds.minCostCoverageRate);
  if (!Number.isFinite(thresholds.minQualityScore) || thresholds.minQualityScore < 0 || thresholds.minQualityScore > 100) throw new Error("minQualityScore 必须在 0-100 之间");
  if (!Number.isFinite(thresholds.maxP95LatencyMs) || thresholds.maxP95LatencyMs < 0) throw new Error("maxP95LatencyMs 必须是非负有限数");
  if (thresholds.maxAverageActualCostUsd !== null && (!Number.isFinite(thresholds.maxAverageActualCostUsd) || thresholds.maxAverageActualCostUsd < 0)) {
    throw new Error("maxAverageActualCostUsd 必须是非负有限数或 null");
  }

  const failures: PromotionFailure[] = [];
  const add = (code: PromotionFailureCode, message: string, actual: number | null, required: number) => failures.push({ code, message, actual, required });

  if (metrics.sampleCount < thresholds.minSamples) add("samples", "样本数不足", metrics.sampleCount, thresholds.minSamples);
  if (metrics.distinctCaseCount < thresholds.minDistinctCases) {
    add("distinct-cases", "Golden case 种类数不足", metrics.distinctCaseCount, thresholds.minDistinctCases);
  }
  if (metrics.successRate < thresholds.minSuccessRate) add("success-rate", "成功率未达标", metrics.successRate, thresholds.minSuccessRate);

  if (thresholds.minStructurePassRate !== null) {
    if (metrics.structurePassRate === null) add("structure-unavailable", "结构通过率缺失", null, thresholds.minStructurePassRate);
    else if (metrics.structurePassRate < thresholds.minStructurePassRate) add("structure-rate", "结构通过率未达标", metrics.structurePassRate, thresholds.minStructurePassRate);
  }

  if (metrics.qualityCoverageRate < thresholds.minQualityCoverageRate) {
    add("quality-coverage", "质量评分覆盖率未达标", metrics.qualityCoverageRate, thresholds.minQualityCoverageRate);
  }
  if (metrics.qualityScore === null) add("quality-unavailable", "质量分缺失", null, thresholds.minQualityScore);
  else if (metrics.qualityScore < thresholds.minQualityScore) add("quality-score", "质量分未达标", metrics.qualityScore, thresholds.minQualityScore);

  if (metrics.p95LatencyMs > thresholds.maxP95LatencyMs) add("latency", "P95 延时超标", metrics.p95LatencyMs, thresholds.maxP95LatencyMs);

  if (metrics.costCoverageRate < thresholds.minCostCoverageRate) {
    add("cost-coverage", "真实成本覆盖率未达标", metrics.costCoverageRate, thresholds.minCostCoverageRate);
  }
  if (thresholds.requireCostLimit && thresholds.maxAverageActualCostUsd === null) {
    add("cost-threshold-unconfigured", "媒体成本上限未配置，禁止晋级", null, 0);
  } else if (thresholds.maxAverageActualCostUsd !== null) {
    if (metrics.averageActualCostUsd === null) add("cost-unavailable", "真实成本数据不完整", null, thresholds.maxAverageActualCostUsd);
    else if (metrics.averageActualCostUsd > thresholds.maxAverageActualCostUsd) {
      add("cost", "平均真实成本超标", metrics.averageActualCostUsd, thresholds.maxAverageActualCostUsd);
    }
  }

  return { passed: failures.length === 0, failures };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
