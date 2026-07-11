import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./后端/saas/db/auth-schema.ts",
    "./后端/saas/db/project-schema.ts",
  ],
  out: "./后端/saas/db/migrations",
  strict: true,
  verbose: true,
});
