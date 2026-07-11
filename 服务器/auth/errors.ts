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
