import "server-only";

import type { CompleteAuthRepository } from "@server/auth/repository";
import { assertSafeAuthRuntime } from "@server/auth/identity-provider";
import { resolveSaasDatabaseConfig } from "./config";
import {
  createSaasPool,
  type SaasPoolFactory,
} from "./postgres-client";
import {
  PostgresAuthRepository,
  type PgQueryExecutor,
} from "./postgres-auth-repository";

export type SaasAuthRuntime =
  | {
      enabled: false;
      code: "AUTH_RUNTIME_NOT_CONFIGURED";
      reason: string;
    }
  | {
      enabled: true;
      repository: CompleteAuthRepository;
      close(): Promise<void>;
    };

type AuthRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type SaasAuthRuntimeDependencies = {
  poolFactory?: SaasPoolFactory;
  repositoryFactory?: (executor: PgQueryExecutor) => CompleteAuthRepository;
};

export function createSaasAuthRuntime(
  env: AuthRuntimeEnvironment = process.env,
  dependencies: SaasAuthRuntimeDependencies = {},
): SaasAuthRuntime {
  assertSafeAuthRuntime(env as NodeJS.ProcessEnv);
  const config = resolveSaasDatabaseConfig(env);
  if (!config.enabled) {
    return {
      enabled: false,
      code: "AUTH_RUNTIME_NOT_CONFIGURED",
      reason: config.reason,
    };
  }

  const pool = createSaasPool(env, dependencies.poolFactory);
  const executor: PgQueryExecutor = {
    query: pool.query.bind(pool) as PgQueryExecutor["query"],
  };
  const repository = dependencies.repositoryFactory?.(executor)
    ?? new PostgresAuthRepository(executor);

  return {
    enabled: true,
    repository,
    close: () => pool.end(),
  };
}

let sharedRuntime: SaasAuthRuntime | undefined;

export function getSaasAuthRuntime() {
  sharedRuntime ??= createSaasAuthRuntime();
  return sharedRuntime;
}
