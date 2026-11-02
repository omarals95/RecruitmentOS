import { existsSync } from "node:fs";
// Secrets remain in ignored local files; Vercel injects environment variables itself.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
else if (existsSync(".env")) process.loadEnvFile(".env");
