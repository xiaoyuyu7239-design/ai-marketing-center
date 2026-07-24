import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { GoldenAttachment, GoldenCase } from "./golden-set";

export type GoldenFixtureState = "ready" | "disabled" | "missing" | "invalid";

export interface GoldenFixtureReadiness {
  fixtureId: string;
  state: GoldenFixtureState;
  ready: boolean;
  reason: string;
}

interface FileFixtureDefinition {
  kind: "file";
  relativePath: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
}

interface DisabledFixtureDefinition {
  kind: "disabled";
  reason: string;
}

type FixtureDefinition = FileFixtureDefinition | DisabledFixtureDefinition;

const FIXTURES: Readonly<Record<string, FixtureDefinition>> = {
  "golden.product.juicer.v1": {
    kind: "file",
    relativePath: "public/examples/juicer.png",
    mimeType: "image/png",
    sha256: "8771eda021d772731fdbb9ec931218ee0287377c3c1721fa5cc0dee8e1af117f",
    sizeBytes: 443_773,
  },
  "golden.metrics.douyin-clear.v1": {
    kind: "disabled",
    reason: "OCR 标准截图尚未入库并固定真值，为避免错误付费已禁用该 case",
  },
  "golden.metrics.chat-page.v1": {
    kind: "disabled",
    reason: "OCR 负样本截图尚未入库，为避免错误付费已禁用该 case",
  },
};

export class GoldenFixtureUnavailableError extends Error {
  readonly fixtureId: string;
  readonly state: Exclude<GoldenFixtureState, "ready">;

  constructor(fixtureId: string, state: Exclude<GoldenFixtureState, "ready">, reason: string) {
    super(reason);
    this.name = "GoldenFixtureUnavailableError";
    this.fixtureId = fixtureId;
    this.state = state;
  }
}

function fixturePath(definition: FileFixtureDefinition): string {
  return join(
    /* turbopackIgnore: true */ process.env.HUIMAI_GOLDEN_FIXTURE_ROOT || process.cwd(),
    definition.relativePath,
  );
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readVerifiedFixture(
  fixtureId: string,
  definition: FileFixtureDefinition,
): Promise<Buffer> {
  let value: Buffer;
  try {
    value = await readFile(/* turbopackIgnore: true */ fixturePath(definition));
  } catch {
    throw new GoldenFixtureUnavailableError(
      fixtureId,
      "missing",
      `Golden fixture ${fixtureId} 缺失，未发起模型请求`,
    );
  }
  if (value.byteLength !== definition.sizeBytes || sha256(value) !== definition.sha256) {
    throw new GoldenFixtureUnavailableError(
      fixtureId,
      "invalid",
      `Golden fixture ${fixtureId} 与锁定版本不一致，未发起模型请求`,
    );
  }
  return value;
}

export async function getGoldenFixtureReadiness(fixtureId: string): Promise<GoldenFixtureReadiness> {
  const definition = FIXTURES[fixtureId];
  if (!definition) {
    return {
      fixtureId,
      state: "missing",
      ready: false,
      reason: `Golden fixture ${fixtureId} 未注册`,
    };
  }
  if (definition.kind === "disabled") {
    return { fixtureId, state: "disabled", ready: false, reason: definition.reason };
  }
  try {
    await readVerifiedFixture(fixtureId, definition);
    return { fixtureId, state: "ready", ready: true, reason: "样本已锁定并通过完整性校验" };
  } catch (error) {
    if (error instanceof GoldenFixtureUnavailableError) {
      return { fixtureId, state: error.state, ready: false, reason: error.message };
    }
    throw error;
  }
}

export async function resolveGoldenAttachmentDataUrl(attachment: GoldenAttachment): Promise<string> {
  const definition = FIXTURES[attachment.fixtureId];
  if (!definition) {
    throw new GoldenFixtureUnavailableError(
      attachment.fixtureId,
      "missing",
      `Golden fixture ${attachment.fixtureId} 未注册，未发起模型请求`,
    );
  }
  if (definition.kind === "disabled") {
    throw new GoldenFixtureUnavailableError(attachment.fixtureId, "disabled", definition.reason);
  }
  if (definition.mimeType !== attachment.mimeType) {
    throw new GoldenFixtureUnavailableError(
      attachment.fixtureId,
      "invalid",
      `Golden fixture ${attachment.fixtureId} MIME 与 case 定义不一致，未发起模型请求`,
    );
  }
  const value = await readVerifiedFixture(attachment.fixtureId, definition);
  return `data:${definition.mimeType};base64,${value.toString("base64")}`;
}

export async function getGoldenCaseFixtureReadiness(goldenCase: GoldenCase) {
  const fixtures = await Promise.all(
    (goldenCase.input.attachments ?? []).map((attachment) => getGoldenFixtureReadiness(attachment.fixtureId)),
  );
  return {
    ready: fixtures.every((fixture) => fixture.ready),
    fixtures,
  };
}
