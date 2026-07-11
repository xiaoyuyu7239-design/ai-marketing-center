import "server-only";

import { Pool, type PoolConfig } from "pg";
import {
  resolveSaasDatabaseConfig,
  SaasDatabaseConfigurationError,
  type SaasDatabaseEnvironment,
} from "./config";

export type SaasPool = Pick<Pool, "query" | "connect" | "end">;
export type SaasPoolFactory = (config: PoolConfig) => SaasPool;

export function createSaasPool(
  env: SaasDatabaseEnvironment = process.env,
  poolFactory: SaasPoolFactory = (config) => new Pool(config),
) {
  const config = resolveSaasDatabaseConfig(env);
  if (!config.enabled) {
    throw new SaasDatabaseConfigurationError(config.code, config.reason);
  }
  return poolFactory({
    connectionString: config.url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  });
}
