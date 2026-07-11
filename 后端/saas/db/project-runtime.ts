import "server-only";

import type { CompleteAuthRepository } from "@server/auth/repository";
import { assertSafeAuthRuntime } from "@server/auth/identity-provider";
import type { ProjectRepository } from "@server/projects/repository";
import { resolveSaasDatabaseConfig } from "./config";
import {
  createSaasPool,
  type SaasPoolFactory,
} from "./postgres-client";
import {
  PostgresAuthRepository,
  type PgQueryExecutor,
} from "./postgres-auth-repository";
import { PostgresProjectRepository } from "./postgres-project-repository";
import type {
  WorkspaceTransactionClient,
  WorkspaceTransactionPool,
} from "./workspace-transaction";

export type SaasProjectRuntime =
  | {
      enabled: false;
      code: "AUTH_RUNTIME_NOT_CONFIGURED";
      reason: string;
    }
  | {
      enabled: true;
      authRepository: CompleteAuthRepository;
      projectRepository: ProjectRepository;
      close(): Promise<void>;
    };

type ProjectRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type SaasProjectRuntimeDependencies = {
  poolFactory?: SaasPoolFactory;
  authRepositoryFactory?: (executor: PgQueryExecutor) => CompleteAuthRepository;
  projectRepositoryFactory?: (pool: WorkspaceTransactionPool) => ProjectRepository;
};

export function createSaasProjectRuntime(
  env: ProjectRuntimeEnvironment = process.env,
  dependencies: SaasProjectRuntimeDependencies = {},
): SaasProjectRuntime {
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
  const workspacePool: WorkspaceTransactionPool = {
    async connect() {
      const client = await pool.connect();
      return {
        query: client.query.bind(client) as WorkspaceTransactionClient["query"],
        release: () => client.release(),
      };
    },
  };

  return {
    enabled: true,
    authRepository: dependencies.authRepositoryFactory?.(executor)
      ?? new PostgresAuthRepository(executor),
    projectRepository: dependencies.projectRepositoryFactory?.(workspacePool)
      ?? new PostgresProjectRepository(workspacePool),
    close: () => pool.end(),
  };
}

let sharedRuntime: SaasProjectRuntime | undefined;

export function getSaasProjectRuntime() {
  sharedRuntime ??= createSaasProjectRuntime();
  return sharedRuntime;
}
