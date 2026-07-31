import { defineConfig } from "drizzle-kit";

// Used only for generating future migrations from schema changes:
//   npx drizzle-kit generate
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations"
});
