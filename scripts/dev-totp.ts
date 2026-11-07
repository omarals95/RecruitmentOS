import "./load-env";
import { seedTotpCode } from "./totp";

// Prints the fictional seed owner's current sign-in code for local browser checks.
try {
  console.log(seedTotpCode(process.env));
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "No sign-in code available.",
  );
  process.exitCode = 1;
}
