import "server-only";

import type { SessionRepository } from "./repository";
import {
  AUTH_SESSION_MAX_AGE_SECONDS,
  generateSessionToken,
  hashSessionToken,
  isValidSessionToken,
} from "./session-token";

export async function createPersistentSession(
  userId: string,
  repository: SessionRepository,
  now: () => Date = () => new Date(),
) {
  const createdAt = now();
  const expiresAt = new Date(
    createdAt.getTime() + AUTH_SESSION_MAX_AGE_SECONDS * 1_000,
  );
  const token = generateSessionToken();
  const sessionId = await repository.createSession({
    userId,
    tokenDigest: hashSessionToken(token),
    expiresAt,
    createdAt,
  });
  return { sessionId, token, expiresAt };
}

export async function revokePersistentSession(
  token: string,
  repository: SessionRepository,
  now: () => Date = () => new Date(),
) {
  if (!isValidSessionToken(token)) return false;
  return repository.revokeSessionByTokenDigest(hashSessionToken(token), now());
}

export function revokeAllPersistentSessions(
  userId: string,
  repository: SessionRepository,
  now: () => Date = () => new Date(),
) {
  return repository.revokeSessionsForUser(userId, now());
}
