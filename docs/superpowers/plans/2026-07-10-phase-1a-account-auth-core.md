# Phase 1A Account and Auth Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the vendor-neutral, testable account-domain foundation for users, external identities, sessions, workspaces, memberships, invitations, opaque session tokens, AuthContext authorization, and development-only identity injection without claiming that PostgreSQL or a public login provider is connected.

**Architecture:** Keep the frozen SQLite runtime untouched and place PostgreSQL-only SaaS definitions under `后端/saas/db/`. Put authentication policy under `服务器/auth/` behind a repository port so it can be tested without a database driver and later bound to standard PostgreSQL. This slice does not add login routes or unlock any production business API; those steps require a real PostgreSQL connection, migrations, integration tests, and a selected public identity provider.

**Tech Stack:** Next.js 16.2.1, TypeScript 5, Vitest 4.1, Drizzle ORM PostgreSQL schema primitives, Node.js crypto.

## Global Constraints

- Do not modify `audit/2026-07-10-product-readiness/`, `后端/db/schema.ts`, `后端/db/index.ts`, `drizzle.config.ts`, or the existing SQLite migrations.
- Do not add SQLite/PostgreSQL dual writes or a runtime dialect switch.
- Do not bind an SMS, email, OAuth, payment, object-storage, queue, or PostgreSQL hosting vendor.
- Do not add an external dependency in this slice; `drizzle-orm/pg-core` and Node.js crypto are already available.
- Do not expose a public login route while no provider has been selected.
- Development identity injection requires `NODE_ENV !== "production"` and `CLIPFORGE_DEV_AUTH_ENABLED=1`; production must reject the module configuration if the flag is present.
- Keep the Phase 0 production business API gate unchanged. No business route is unlocked in this plan.
- Do not describe schema definitions, repository ports, or in-memory tests as a connected database, persisted session, or live cloud account.
- The workspace has no `.git`; preserve intended commit boundaries but do not claim commits were created.
- Use `npm` for verification in the current shell.

## Explicitly Deferred From This Slice

- PostgreSQL client selection, `DATABASE_URL` wiring, migration generation/application, and database integration tests.
- A PostgreSQL implementation of `AuthRepository` and persisted session creation/revocation.
- `/api/auth/session`, login callback, logout, workspace selection, membership, and invitation Route Handlers.
- Replacing the production API gate route-by-route.

These items are not considered complete by this plan. They require a follow-up executable plan once a real PostgreSQL test target and public identity-provider decision are available.

---

### Task 1: Define the account domain and isolated PostgreSQL schema

**Files:**
- Create: `服务器/auth/model.ts`
- Create: `后端/saas/db/auth-schema.ts`
- Test: `src/lib/__tests__/saas-auth-schema.test.ts`

**Interfaces:**
- Produces: `USER_STATUSES`, `PLATFORM_ROLES`, `WORKSPACE_STATUSES`, `WORKSPACE_ROLES`, `INVITATION_STATUSES`, `CONTACT_TYPES`, and their TypeScript union types.
- Produces: PostgreSQL table definitions `users`, `authIdentities`, `sessions`, `workspaces`, `memberships`, and `workspaceInvitations`.
- Consumes: only `drizzle-orm`, `drizzle-orm/pg-core`, and domain constants from `@server/auth/model`.

- [x] **Step 1: Write the failing schema contract test**

Create `src/lib/__tests__/saas-auth-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  authIdentities,
  contactTypeEnum,
  invitationStatusEnum,
  memberships,
  platformRoleEnum,
  sessions,
  users,
  userStatusEnum,
  workspaceInvitations,
  workspaceRoleEnum,
  workspaces,
  workspaceStatusEnum,
} from "@backend/saas/db/auth-schema";

function columnNames(table: Parameters<typeof getTableConfig>[0]) {
  return getTableConfig(table).columns.map((column) => column.name);
}

describe("SaaS auth PostgreSQL schema", () => {
  it("defines the fixed status and role vocabularies", () => {
    expect(userStatusEnum.enumValues).toEqual(["active", "suspended", "deleted"]);
    expect(platformRoleEnum.enumValues).toEqual(["user", "admin"]);
    expect(workspaceStatusEnum.enumValues).toEqual(["active", "suspended", "archived"]);
    expect(workspaceRoleEnum.enumValues).toEqual(["owner", "admin", "member"]);
    expect(invitationStatusEnum.enumValues).toEqual(["pending", "accepted", "revoked", "expired"]);
    expect(contactTypeEnum.enumValues).toEqual(["email", "phone", "external"]);
  });

  it("stores only an opaque session-token digest", () => {
    const columns = columnNames(sessions);
    expect(columns).toContain("token_digest");
    expect(columns).not.toContain("token");
    expect(columns).toEqual(expect.arrayContaining([
      "user_id",
      "expires_at",
      "revoked_at",
      "last_used_at",
    ]));
  });

  it("models identities, tenant membership, and invitations independently", () => {
    expect(getTableConfig(users).name).toBe("users");
    expect(columnNames(authIdentities)).toEqual(expect.arrayContaining([
      "provider",
      "provider_subject",
      "verified_contact",
      "verified_at",
    ]));
    expect(columnNames(workspaces)).toEqual(expect.arrayContaining(["slug", "name", "status"]));
    expect(columnNames(memberships)).toEqual(expect.arrayContaining(["workspace_id", "user_id", "role"]));
    expect(columnNames(workspaceInvitations)).toEqual(expect.arrayContaining([
      "workspace_id",
      "target_contact",
      "contact_type",
      "role",
      "status",
      "invited_by_user_id",
    ]));
  });

  it("declares database uniqueness for external subjects and session digests", () => {
    const identityIndexes = getTableConfig(authIdentities).indexes.map((index) => index.config.name);
    const sessionIndexes = getTableConfig(sessions).indexes.map((index) => index.config.name);
    expect(identityIndexes).toContain("auth_identities_provider_subject_unique");
    expect(sessionIndexes).toContain("sessions_token_digest_unique");
  });
});
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- src/lib/__tests__/saas-auth-schema.test.ts
```

Expected: FAIL because `@backend/saas/db/auth-schema` and `@server/auth/model` do not exist.

- [x] **Step 3: Add the shared domain vocabulary**

Create `服务器/auth/model.ts`:

```ts
export const USER_STATUSES = ["active", "suspended", "deleted"] as const;
export const PLATFORM_ROLES = ["user", "admin"] as const;
export const WORKSPACE_STATUSES = ["active", "suspended", "archived"] as const;
export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export const INVITATION_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;
export const CONTACT_TYPES = ["email", "phone", "external"] as const;

export type UserStatus = (typeof USER_STATUSES)[number];
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];
export type ContactType = (typeof CONTACT_TYPES)[number];
```

- [x] **Step 4: Add the PostgreSQL-only account schema**

Create `后端/saas/db/auth-schema.ts`:

```ts
import { sql } from "drizzle-orm";
import {
  char,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  CONTACT_TYPES,
  INVITATION_STATUSES,
  PLATFORM_ROLES,
  USER_STATUSES,
  WORKSPACE_ROLES,
  WORKSPACE_STATUSES,
} from "@server/auth/model";

export const userStatusEnum = pgEnum("saas_user_status", USER_STATUSES);
export const platformRoleEnum = pgEnum("saas_platform_role", PLATFORM_ROLES);
export const workspaceStatusEnum = pgEnum("saas_workspace_status", WORKSPACE_STATUSES);
export const workspaceRoleEnum = pgEnum("saas_workspace_role", WORKSPACE_ROLES);
export const invitationStatusEnum = pgEnum("saas_invitation_status", INVITATION_STATUSES);
export const contactTypeEnum = pgEnum("saas_contact_type", CONTACT_TYPES);

const timestampColumn = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  status: userStatusEnum("status").notNull().default("active"),
  platformRole: platformRoleEnum("platform_role").notNull().default("user"),
  displayName: text("display_name"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
});

export const authIdentities = pgTable("auth_identities", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerSubject: text("provider_subject").notNull(),
  contactType: contactTypeEnum("contact_type").notNull(),
  verifiedContact: text("verified_contact").notNull(),
  verifiedAt: timestampColumn("verified_at").notNull(),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("auth_identities_provider_subject_unique").on(table.provider, table.providerSubject),
  index("auth_identities_user_id_index").on(table.userId),
  index("auth_identities_verified_contact_index").on(table.contactType, table.verifiedContact),
]);

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tokenDigest: char("token_digest", { length: 64 }).notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestampColumn("expires_at").notNull(),
  revokedAt: timestampColumn("revoked_at"),
  lastUsedAt: timestampColumn("last_used_at").notNull().defaultNow(),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sessions_token_digest_unique").on(table.tokenDigest),
  index("sessions_user_id_index").on(table.userId),
  index("sessions_expires_at_index").on(table.expiresAt),
]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  status: workspaceStatusEnum("status").notNull().default("active"),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("workspaces_slug_unique").on(table.slug),
  index("workspaces_created_by_user_id_index").on(table.createdByUserId),
]);

export const memberships = pgTable("memberships", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: workspaceRoleEnum("role").notNull().default("member"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "memberships_pkey", columns: [table.workspaceId, table.userId] }),
  index("memberships_user_id_index").on(table.userId),
]);

export const workspaceInvitations = pgTable("workspace_invitations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  targetContact: text("target_contact").notNull(),
  contactType: contactTypeEnum("contact_type").notNull(),
  role: workspaceRoleEnum("role").notNull().default("member"),
  status: invitationStatusEnum("status").notNull().default("pending"),
  invitedByUserId: uuid("invited_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, { onDelete: "set null" }),
  expiresAt: timestampColumn("expires_at").notNull(),
  acceptedAt: timestampColumn("accepted_at"),
  revokedAt: timestampColumn("revoked_at"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("workspace_invitations_pending_contact_unique")
    .on(table.workspaceId, table.contactType, table.targetContact)
    .where(sql`${table.status} = 'pending'`),
  index("workspace_invitations_workspace_id_index").on(table.workspaceId),
  index("workspace_invitations_target_contact_index").on(table.contactType, table.targetContact),
]);
```

- [x] **Step 5: Run the schema test and typecheck**

Run:

```bash
npm test -- src/lib/__tests__/saas-auth-schema.test.ts
npm run typecheck
```

Expected: the focused test passes and TypeScript exits 0.

- [x] **Step 6: Preserve the intended commit boundary**

When Git history exists, the intended commit is:

```bash
git add 服务器/auth/model.ts 后端/saas/db/auth-schema.ts src/lib/__tests__/saas-auth-schema.test.ts
git commit -m "feat: define SaaS account schema"
```

### Task 2: Add opaque session-token and Cookie primitives

**Files:**
- Create: `服务器/auth/session-token.ts`
- Test: `src/lib/__tests__/saas-session-token.test.ts`

**Interfaces:**
- Produces: `AUTH_COOKIE_NAME`, `AUTH_SESSION_MAX_AGE_SECONDS`, `generateSessionToken()`, `isValidSessionToken()`, `hashSessionToken()`, `sessionCookieOptions()`, and `clearedSessionCookieOptions()`.
- Consumes: Node.js `randomBytes` and `createHash`; no database or Next.js request object.

- [x] **Step 1: Write the failing token test**

Create `src/lib/__tests__/saas-session-token.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AUTH_COOKIE_NAME,
  AUTH_SESSION_MAX_AGE_SECONDS,
  clearedSessionCookieOptions,
  generateSessionToken,
  hashSessionToken,
  isValidSessionToken,
  sessionCookieOptions,
} from "@server/auth/session-token";

if (false) {
  // @ts-expect-error Session-token callers must not provide custom entropy.
  generateSessionToken(Buffer.alloc(32, 7));
}

describe("SaaS session-token primitives", () => {
  it("generates a 256-bit opaque base64url token and stores a SHA-256 digest", () => {
    const token = generateSessionToken();
    const secondToken = generateSessionToken();
    expect(isValidSessionToken(token)).toBe(true);
    expect(token).toHaveLength(43);
    expect(secondToken).not.toBe(token);
    expect(hashSessionToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSessionToken(token)).not.toContain(token);
  });

  it("rejects malformed tokens before hashing", () => {
    expect(isValidSessionToken("plain-session-id")).toBe(false);
    expect(() => hashSessionToken("plain-session-id")).toThrow("Invalid session token");
  });

  it("uses an HttpOnly, same-site, finite Cookie and enables Secure in production", () => {
    const expiresAt = new Date("2030-01-01T00:00:00.000Z");
    expect(AUTH_COOKIE_NAME).toBe("clipforge_session");
    expect(AUTH_SESSION_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 7);
    expect(sessionCookieOptions(expiresAt, "production")).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
      expires: expiresAt,
    });
    expect(sessionCookieOptions(expiresAt, "development").secure).toBe(false);
    expect(clearedSessionCookieOptions("production")).toMatchObject({ maxAge: 0, secure: true });
  });
});
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- src/lib/__tests__/saas-session-token.test.ts
```

Expected: FAIL because `@server/auth/session-token` does not exist.

- [x] **Step 3: Implement the minimal token module**

Create `服务器/auth/session-token.ts`:

```ts
import "server-only";

import { createHash, randomBytes } from "crypto";

export const AUTH_COOKIE_NAME = "clipforge_session";
export const AUTH_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type SessionCookieOptions = {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
  expires?: Date;
};

export function generateSessionToken() {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

export function isValidSessionToken(token: string) {
  return SESSION_TOKEN_PATTERN.test(token);
}

export function hashSessionToken(token: string) {
  if (!isValidSessionToken(token)) throw new Error("Invalid session token");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function sessionCookieOptions(expires: Date, nodeEnv = process.env.NODE_ENV): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
    expires,
  };
}

export function clearedSessionCookieOptions(nodeEnv = process.env.NODE_ENV): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  };
}
```

- [x] **Step 4: Run focused tests and typecheck**

Run:

```bash
npm test -- src/lib/__tests__/saas-session-token.test.ts
npm run typecheck
```

Expected: the focused test passes and TypeScript exits 0.

- [x] **Step 5: Preserve the intended commit boundary**

When Git history exists, the intended commit is:

```bash
git add 服务器/auth/session-token.ts src/lib/__tests__/saas-session-token.test.ts
git commit -m "feat: add opaque session token primitives"
```

### Task 3: Define the vendor-neutral AuthContext authorization contract

**Files:**
- Create: `服务器/auth/errors.ts`
- Create: `服务器/auth/auth-context.ts`
- Test: `src/lib/__tests__/saas-auth-context.test.ts`

**Interfaces:**
- Consumes: `AUTH_COOKIE_NAME`, `hashSessionToken()`, user/workspace status and role types.
- Produces: `AuthRepository`, `AuthContext`, `AuthContextDependencies`, `getOptionalAuthContext(request, dependencies)`, `requireUser(request, dependencies)`, `requireWorkspace(request, dependencies)`, `requireWorkspaceRole(request, roles, dependencies)`, and `requirePlatformAdmin(request, dependencies)`.
- Produces: typed `AuthError` with stable status/code pairs for future JSON error mapping.
- Workspace selection contract: clients send `x-clipforge-workspace-id`; the repository must verify active membership and workspace state. A header is never trusted as authorization by itself.

- [x] **Step 1: Write failing authorization tests with an in-memory repository fake**

Create `src/lib/__tests__/saas-auth-context.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  getOptionalAuthContext,
  requirePlatformAdmin,
  requireUser,
  requireWorkspace,
  requireWorkspaceRole,
  type AuthRepository,
  type SessionAuthRecord,
  type WorkspaceMembershipRecord,
} from "@server/auth/auth-context";
import { generateSessionToken, hashSessionToken } from "@server/auth/session-token";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const TOKEN = generateSessionToken();
const TOKEN_DIGEST = hashSessionToken(TOKEN);

const activeSession: SessionAuthRecord = {
  sessionId: "session-1",
  userId: "user-1",
  userStatus: "active",
  platformRole: "user",
  expiresAt: new Date("2030-01-02T00:00:00.000Z"),
  revokedAt: null,
};

const activeMembership: WorkspaceMembershipRecord = {
  workspaceId: "workspace-1",
  workspaceName: "Store One",
  workspaceStatus: "active",
  role: "member",
};

function repository(
  session: SessionAuthRecord | null = activeSession,
  membership: WorkspaceMembershipRecord | null = activeMembership,
): AuthRepository {
  return {
    async findSessionByTokenDigest(tokenDigest) {
      return tokenDigest === TOKEN_DIGEST ? session : null;
    },
    async findWorkspaceMembership(userId, workspaceId) {
      return userId === session?.userId && workspaceId === membership?.workspaceId ? membership : null;
    },
  };
}

function request(options: { token?: string | null; workspaceId?: string } = {}) {
  const headers = new Headers();
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("cookie", `clipforge_session=${token}`);
  if (options.workspaceId) headers.set("x-clipforge-workspace-id", options.workspaceId);
  return new Request("http://localhost/api/project", { headers });
}

function dependencies(authRepository: AuthRepository) {
  return {
    repository: authRepository,
    now: () => NOW,
    createRequestId: () => "request-1",
  };
}

describe("SaaS AuthContext", () => {
  it("returns null for absent, malformed, expired, revoked, or suspended sessions", async () => {
    await expect(getOptionalAuthContext(request({ token: null }), dependencies(repository()))).resolves.toBeNull();
    await expect(getOptionalAuthContext(request({ token: "plain-session-id" }), dependencies(repository()))).resolves.toBeNull();
    await expect(getOptionalAuthContext(request(), dependencies(repository({
      ...activeSession,
      expiresAt: NOW,
    })))).resolves.toBeNull();
    await expect(getOptionalAuthContext(request(), dependencies(repository({
      ...activeSession,
      revokedAt: new Date("2029-12-31T23:00:00.000Z"),
    })))).resolves.toBeNull();
    await expect(getOptionalAuthContext(request(), dependencies(repository({
      ...activeSession,
      userStatus: "suspended",
    })))).resolves.toBeNull();
  });

  it("returns a user context without a workspace when no workspace header is present", async () => {
    await expect(getOptionalAuthContext(request(), dependencies(repository()))).resolves.toMatchObject({
      requestId: "request-1",
      user: { id: "user-1", platformRole: "user" },
      session: { id: "session-1" },
      workspace: null,
    });
  });

  it("requires an authenticated user with AUTH_REQUIRED/401", async () => {
    await expect(requireUser(request({ token: null }), dependencies(repository()))).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
  });

  it("requires an active workspace membership with WORKSPACE_FORBIDDEN/403", async () => {
    await expect(requireWorkspace(
      request({ workspaceId: "workspace-2" }),
      dependencies(repository(activeSession, null)),
    )).rejects.toMatchObject({ status: 403, code: "WORKSPACE_FORBIDDEN" });
  });

  it("accepts only explicitly allowed workspace roles", async () => {
    await expect(requireWorkspaceRole(
      request({ workspaceId: "workspace-1" }),
      ["owner"],
      dependencies(repository()),
    )).rejects.toMatchObject({ status: 403, code: "INSUFFICIENT_WORKSPACE_ROLE" });
    await expect(requireWorkspaceRole(
      request({ workspaceId: "workspace-1" }),
      ["member"],
      dependencies(repository()),
    )).resolves.toMatchObject({ workspace: { role: "member" } });
  });

  it("does not treat a workspace owner as a platform administrator", async () => {
    await expect(requirePlatformAdmin(
      request({ workspaceId: "workspace-1" }),
      dependencies(repository(activeSession, { ...activeMembership, role: "owner" })),
    )).rejects.toMatchObject({ status: 403, code: "PLATFORM_ADMIN_REQUIRED" });
  });

  it("allows a platform admin without granting an unrelated workspace membership", async () => {
    const adminSession = { ...activeSession, platformRole: "admin" } as const;
    await expect(requirePlatformAdmin(request(), dependencies(repository(adminSession, null))))
      .resolves.toMatchObject({ user: { platformRole: "admin" } });
    await expect(requireWorkspace(
      request({ workspaceId: "workspace-2" }),
      dependencies(repository(adminSession, null)),
    )).rejects.toMatchObject({ status: 403, code: "WORKSPACE_FORBIDDEN" });
  });
});
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- src/lib/__tests__/saas-auth-context.test.ts
```

Expected: FAIL because the AuthContext and error modules do not exist.

- [x] **Step 3: Implement stable authorization errors**

Create `服务器/auth/errors.ts`:

```ts
export type AuthErrorCode =
  | "AUTH_REQUIRED"
  | "WORKSPACE_FORBIDDEN"
  | "INSUFFICIENT_WORKSPACE_ROLE"
  | "PLATFORM_ADMIN_REQUIRED";

export class AuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
```

- [x] **Step 4: Implement the repository port and AuthContext functions**

Create `服务器/auth/auth-context.ts`:

```ts
import "server-only";

import { randomUUID } from "crypto";
import type {
  PlatformRole,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from "./model";
import { AuthError } from "./errors";
import {
  AUTH_COOKIE_NAME,
  hashSessionToken,
  isValidSessionToken,
} from "./session-token";

export type SessionAuthRecord = {
  sessionId: string;
  userId: string;
  userStatus: UserStatus;
  platformRole: PlatformRole;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type WorkspaceMembershipRecord = {
  workspaceId: string;
  workspaceName: string;
  workspaceStatus: WorkspaceStatus;
  role: WorkspaceRole;
};

export interface AuthRepository {
  findSessionByTokenDigest(tokenDigest: string): Promise<SessionAuthRecord | null>;
  findWorkspaceMembership(userId: string, workspaceId: string): Promise<WorkspaceMembershipRecord | null>;
}

export type AuthContextDependencies = {
  repository: AuthRepository;
  now?: () => Date;
  createRequestId?: () => string;
};

export type AuthContext = {
  requestId: string;
  user: {
    id: string;
    platformRole: PlatformRole;
  };
  session: {
    id: string;
    expiresAt: Date;
  };
  workspace: null | {
    id: string;
    name: string;
    role: WorkspaceRole;
  };
};

function readCookie(request: Request, name: string) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

export async function getOptionalAuthContext(
  request: Request,
  dependencies: AuthContextDependencies,
): Promise<AuthContext | null> {
  const token = readCookie(request, AUTH_COOKIE_NAME);
  if (!token || !isValidSessionToken(token)) return null;

  const session = await dependencies.repository.findSessionByTokenDigest(hashSessionToken(token));
  const now = dependencies.now?.() ?? new Date();
  if (
    !session
    || session.revokedAt !== null
    || session.expiresAt.getTime() <= now.getTime()
    || session.userStatus !== "active"
  ) {
    return null;
  }

  const requestedWorkspaceId = request.headers.get("x-clipforge-workspace-id")?.trim() ?? "";
  let workspace: AuthContext["workspace"] = null;
  if (requestedWorkspaceId) {
    const membership = await dependencies.repository.findWorkspaceMembership(session.userId, requestedWorkspaceId);
    if (membership?.workspaceStatus === "active") {
      workspace = {
        id: membership.workspaceId,
        name: membership.workspaceName,
        role: membership.role,
      };
    }
  }

  return {
    requestId: dependencies.createRequestId?.() ?? randomUUID(),
    user: { id: session.userId, platformRole: session.platformRole },
    session: { id: session.sessionId, expiresAt: session.expiresAt },
    workspace,
  };
}

export async function requireUser(request: Request, dependencies: AuthContextDependencies) {
  const context = await getOptionalAuthContext(request, dependencies);
  if (!context) throw new AuthError(401, "AUTH_REQUIRED", "A valid user session is required");
  return context;
}

export async function requireWorkspace(request: Request, dependencies: AuthContextDependencies) {
  const context = await requireUser(request, dependencies);
  if (!context.workspace) {
    throw new AuthError(403, "WORKSPACE_FORBIDDEN", "An active workspace membership is required");
  }
  return context as AuthContext & { workspace: NonNullable<AuthContext["workspace"]> };
}

export async function requireWorkspaceRole(
  request: Request,
  roles: readonly WorkspaceRole[],
  dependencies: AuthContextDependencies,
) {
  const context = await requireWorkspace(request, dependencies);
  if (!roles.includes(context.workspace.role)) {
    throw new AuthError(403, "INSUFFICIENT_WORKSPACE_ROLE", "The workspace role is not allowed");
  }
  return context;
}

export async function requirePlatformAdmin(request: Request, dependencies: AuthContextDependencies) {
  const context = await requireUser(request, dependencies);
  if (context.user.platformRole !== "admin") {
    throw new AuthError(403, "PLATFORM_ADMIN_REQUIRED", "Platform administrator access is required");
  }
  return context;
}
```

- [x] **Step 5: Run focused tests and typecheck**

Run:

```bash
npm test -- src/lib/__tests__/saas-session-token.test.ts src/lib/__tests__/saas-auth-context.test.ts
npm run typecheck
```

Expected: both focused suites pass and TypeScript exits 0.

- [x] **Step 6: Preserve the intended commit boundary**

When Git history exists, the intended commit is:

```bash
git add 服务器/auth/errors.ts 服务器/auth/auth-context.ts src/lib/__tests__/saas-auth-context.test.ts
git commit -m "feat: define SaaS auth context contract"
```

### Task 4: Add provider-neutral verified identity and fail-closed development injection

**Files:**
- Create: `服务器/auth/identity-provider.ts`
- Create: `服务器/auth/index.ts`
- Test: `src/lib/__tests__/saas-identity-provider.test.ts`

**Interfaces:**
- Produces: `VerifiedExternalIdentity`, `IdentityProviderAdapter`, `resolveDevelopmentIdentityConfig()`, `assertSafeAuthRuntime()`, and `createDevelopmentIdentity()`.
- Consumes: only `ContactType` from the domain model; it does not create users, workspaces, memberships, or sessions.
- `服务器/auth/index.ts` is the public barrel for the account/auth core and must not instantiate a database repository.

- [x] **Step 1: Write the failing provider-boundary tests**

Create `src/lib/__tests__/saas-identity-provider.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  assertSafeAuthRuntime,
  createDevelopmentIdentity,
  resolveDevelopmentIdentityConfig,
} from "@server/auth/identity-provider";

describe("identity-provider boundary", () => {
  it("keeps development identity injection disabled unless explicitly enabled", () => {
    expect(resolveDevelopmentIdentityConfig({ NODE_ENV: "development" })).toEqual({ enabled: false });
  });

  it("allows explicit development injection outside production", () => {
    const env = { NODE_ENV: "test", CLIPFORGE_DEV_AUTH_ENABLED: "1" } as NodeJS.ProcessEnv;
    expect(resolveDevelopmentIdentityConfig(env)).toEqual({ enabled: true });
    expect(createDevelopmentIdentity({
      providerSubject: "developer-1",
      contactType: "email",
      verifiedContact: "developer@example.test",
    }, env)).toMatchObject({ provider: "development", providerSubject: "developer-1" });
  });

  it("rejects development identity injection in production", () => {
    const env = { NODE_ENV: "production", CLIPFORGE_DEV_AUTH_ENABLED: "1" } as NodeJS.ProcessEnv;
    expect(() => assertSafeAuthRuntime(env)).toThrow("Development identity injection cannot be enabled in production");
    expect(() => createDevelopmentIdentity({
      providerSubject: "developer-1",
      contactType: "email",
      verifiedContact: "developer@example.test",
    }, env)).toThrow("Development identity injection cannot be enabled in production");
  });

  it("does not accept empty provider subjects or unverified contacts", () => {
    const env = { NODE_ENV: "development", CLIPFORGE_DEV_AUTH_ENABLED: "1" } as NodeJS.ProcessEnv;
    expect(() => createDevelopmentIdentity({
      providerSubject: " ",
      contactType: "email",
      verifiedContact: "developer@example.test",
    }, env)).toThrow("Development provider subject is required");
    expect(() => createDevelopmentIdentity({
      providerSubject: "developer-1",
      contactType: "email",
      verifiedContact: " ",
    }, env)).toThrow("Verified development contact is required");
  });
});
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- src/lib/__tests__/saas-identity-provider.test.ts
```

Expected: FAIL because `@server/auth/identity-provider` does not exist.

- [x] **Step 3: Implement the provider-neutral contract and development adapter**

Create `服务器/auth/identity-provider.ts`:

```ts
import "server-only";

import type { ContactType } from "./model";

export type VerifiedExternalIdentity = {
  provider: string;
  providerSubject: string;
  contactType: ContactType;
  verifiedContact: string;
};

export interface IdentityProviderAdapter<TCredential> {
  readonly provider: string;
  verify(credential: TCredential): Promise<VerifiedExternalIdentity>;
}

export function resolveDevelopmentIdentityConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === "production" && env.CLIPFORGE_DEV_AUTH_ENABLED === "1") {
    throw new Error("Development identity injection cannot be enabled in production");
  }
  return { enabled: env.NODE_ENV !== "production" && env.CLIPFORGE_DEV_AUTH_ENABLED === "1" };
}

export function assertSafeAuthRuntime(env: NodeJS.ProcessEnv = process.env) {
  resolveDevelopmentIdentityConfig(env);
}

export function createDevelopmentIdentity(
  input: Omit<VerifiedExternalIdentity, "provider">,
  env: NodeJS.ProcessEnv = process.env,
): VerifiedExternalIdentity {
  if (!resolveDevelopmentIdentityConfig(env).enabled) {
    throw new Error("Development identity injection is disabled");
  }
  const providerSubject = input.providerSubject.trim();
  const verifiedContact = input.verifiedContact.trim();
  if (!providerSubject) throw new Error("Development provider subject is required");
  if (!verifiedContact) throw new Error("Verified development contact is required");
  return { provider: "development", providerSubject, contactType: input.contactType, verifiedContact };
}
```

- [x] **Step 4: Add the public auth-core barrel without a runtime database binding**

Create `服务器/auth/index.ts`:

```ts
export * from "./auth-context";
export * from "./errors";
export * from "./identity-provider";
export * from "./model";
export * from "./session-token";
```

- [x] **Step 5: Run focused and full verification**

Run:

```bash
npm test -- src/lib/__tests__/saas-auth-schema.test.ts src/lib/__tests__/saas-session-token.test.ts src/lib/__tests__/saas-auth-context.test.ts src/lib/__tests__/saas-identity-provider.test.ts
npm test
npm run typecheck
npm run lint
```

Expected: all four new suites pass; the complete Vitest suite passes; TypeScript exits 0; ESLint exits 0 while the previously known warning count may remain non-zero.

- [x] **Step 6: Reconfirm the production gate was not weakened**

Run:

```bash
npm test -- src/lib/__tests__/saas-launch-gate.test.ts
```

Expected: the production business API remains blocked and `/api/admin/*` remains reachable for its own fail-closed authentication.

- [x] **Step 7: Preserve the intended commit boundary**

When Git history exists, the intended commit is:

```bash
git add 服务器/auth/identity-provider.ts 服务器/auth/index.ts src/lib/__tests__/saas-identity-provider.test.ts
git commit -m "feat: add provider-neutral identity boundary"
```

### Task 5: Remove the browser-only fake public login

**Files:**
- Modify: `前端/创作工作台/page.tsx`
- Test: `src/lib/__tests__/public-login-closed.test.ts`

**Interfaces:**
- Removes: `clipforge_user_session`, arbitrary phone/code acceptance, fake “send code” feedback, and browser-only user state.
- Produces: a non-authenticating informational dialog stating that public login remains closed until a real provider is configured.
- Preserves: the existing Phase 0 production API gate and the rest of the workbench layout/creation flow.

- [x] **Step 1: Write the failing fake-login regression test**

Create `src/lib/__tests__/public-login-closed.test.ts`:

```ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const workbenchSource = readFileSync(resolve(process.cwd(), "前端/创作工作台/page.tsx"), "utf8");

describe("public login availability", () => {
  it("does not persist or accept a browser-only user identity", () => {
    expect(workbenchSource).not.toContain("clipforge_user_session");
    expect(workbenchSource).not.toContain("saveUserSession");
    expect(workbenchSource).not.toContain("handleLoginSubmit");
    expect(workbenchSource).not.toContain("发送验证码");
    expect(workbenchSource).not.toContain('type="tel"');
  });

  it("explains that public login remains closed until a real provider is configured", () => {
    expect(workbenchSource).toContain("登录尚未开放");
    expect(workbenchSource).toContain("尚未配置真实登录服务");
  });
});
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- src/lib/__tests__/public-login-closed.test.ts
```

Expected: FAIL because the workbench still contains `clipforge_user_session`, phone/code fields, and fake success behavior.

- [x] **Step 3: Remove fake identity state and success handlers**

In `前端/创作工作台/page.tsx`, remove the `FormEvent` type import, `userSessionKey`, `hasSavedUserSession()`, `saveUserSession()`, `isUserLoggedIn`, `phone`, `verificationCode`, `codeSent`, `agreed`, the session-hydration effect, `canLogin`, and `handleLoginSubmit()`.

Replace the conditional login button behavior with:

```tsx
<button
  type="button"
  onClick={() => setLoginOpen(true)}
  className="rounded-md px-1 py-1 text-[13px] font-extrabold tracking-[0.08em] text-[#6B7280] transition hover:text-[#111111] xl:text-[14px]"
  aria-label="查看登录状态"
  aria-haspopup="dialog"
>
  登录
</button>
```

- [x] **Step 4: Replace the fake form with a non-authenticating dialog**

Replace the phone/code form with a `role="dialog"`, `aria-modal="true"`, and `aria-labelledby="public-login-title"` panel. The dialog must include these exact statements and only a close action:

```tsx
<h2 id="public-login-title">登录尚未开放</h2>
<p>尚未配置真实登录服务。为避免伪登录和数据误认，手机号、验证码和本地身份入口已关闭。</p>
<p>确定首发登录方式并接入服务端会话后，这里才会重新开放。</p>
<button type="button" onClick={() => setLoginOpen(false)}>知道了</button>
```

- [x] **Step 5: Run focused verification**

Run:

```bash
npm test -- src/lib/__tests__/public-login-closed.test.ts
npm run typecheck
```

Expected: the two regression tests pass and TypeScript exits 0.

- [x] **Step 6: Preserve the intended commit boundary**

When Git history exists, the intended commit is:

```bash
git add 前端/创作工作台/page.tsx src/lib/__tests__/public-login-closed.test.ts
git commit -m "fix: close unconfigured public login"
```

## Completion Boundary

This plan is complete only when the five new auth suites, the full unit suite, typecheck, lint, and the Phase 0 production-gate regression all pass. Completion means the account/auth core contracts and PostgreSQL schema definitions exist locally and the unsafe browser-only login has been removed. It does not mean PostgreSQL migrations ran, accounts persist, login works, sessions are stored, or any production business API is open.
