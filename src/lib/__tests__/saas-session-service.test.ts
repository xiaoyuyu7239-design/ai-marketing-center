import { describe, expect, it, vi } from "vitest";
import {
  createPersistentSession,
  revokeAllPersistentSessions,
  revokePersistentSession,
} from "@server/auth/session-service";

describe("persistent session service", () => {
  it("persists only a digest and returns the raw token once", async () => {
    const repository = {
      createSession: vi.fn(async () => "session-1"),
      revokeSessionByTokenDigest: vi.fn(),
      revokeSessionsForUser: vi.fn(),
    };
    const now = new Date("2030-01-01T00:00:00.000Z");
    const result = await createPersistentSession("user-1", repository, () => now);

    expect(result).toMatchObject({
      sessionId: "session-1",
      expiresAt: new Date("2030-01-08T00:00:00.000Z"),
    });
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repository.createSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      tokenDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      createdAt: now,
    }));
    expect(JSON.stringify(repository.createSession.mock.calls)).not.toContain(result.token);
  });

  it("hashes valid tokens before revocation and ignores malformed tokens", async () => {
    const repository = {
      createSession: vi.fn(),
      revokeSessionByTokenDigest: vi.fn(async () => true),
      revokeSessionsForUser: vi.fn(async () => 2),
    };

    await expect(revokePersistentSession("bad-token", repository)).resolves.toBe(false);
    expect(repository.revokeSessionByTokenDigest).not.toHaveBeenCalled();

    const created = await createPersistentSession("user-1", repository);
    await expect(revokePersistentSession(created.token, repository)).resolves.toBe(true);
    expect(repository.revokeSessionByTokenDigest).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(Date),
    );
    expect(JSON.stringify(repository.revokeSessionByTokenDigest.mock.calls)).not.toContain(created.token);

    await expect(revokeAllPersistentSessions("user-1", repository)).resolves.toBe(2);
    expect(repository.revokeSessionsForUser).toHaveBeenCalledWith("user-1", expect.any(Date));
  });
});
