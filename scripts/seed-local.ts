import "./load-env";
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "../src/db";
import { user, account, organization, member } from "../src/db/auth-schema";
import { bootstrapTeam, createRecord } from "../src/lib/records";
import { roleScopes } from "../src/lib/permissions";
import type { Principal } from "../src/lib/principal";
async function main() {
  try {
    await seed();
  } finally {
    // An open PGlite client keeps the process alive after the work is done.
    await closeDb();
  }
}
async function seed() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.DATABASE_MODE !== "pglite" ||
    process.env.ALLOW_LOCAL_DB !== "true"
  )
    throw new Error(
      "Fictional seed is restricted to explicitly enabled local PGlite.",
    );
  const db = await getDb(),
    email = "recruiter@example.test";
  const existing = await db.select().from(user).where(eq(user.email, email));
  if (existing.length) {
    console.log("Fictional seed account already exists. No records changed.");
    return;
  }
  const password =
    process.env.DEV_SEED_PASSWORD || randomBytes(18).toString("base64url");
  if (password.length < 12)
    throw new Error("DEV_SEED_PASSWORD must contain at least 12 characters.");
  const userId = randomUUID(),
    teamId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(user).values({
      id: userId,
      name: "Demo Recruiter",
      email,
      emailVerified: true,
      initialAdmin: true,
    });
    await tx.insert(account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(password),
    });
    await tx.insert(organization).values({
      id: teamId,
      name: "Fictional Studio",
      slug: "fictional-studio",
      createdBy: userId,
    });
    await tx.insert(member).values({
      id: randomUUID(),
      organizationId: teamId,
      userId,
      role: "owner",
    });
  });
  const p: Principal = {
    userId,
    teamId,
    role: "owner",
    scopes: roleScopes("owner"),
    authType: "session",
  };
  await bootstrapTeam(p);
  const role = await createRecord(p, "job-roles", {
    data: {
      title: "Software Engineer",
      department: "Engineering",
      location: "Dubai",
      employmentType: "Full time",
      workMode: "Hybrid",
      description: "Build useful software with a collaborative team.",
      requirements: "TypeScript and software delivery experience.",
      skills: ["TypeScript", "React"],
    },
  });
  const vacancy = await createRecord(p, "vacancies", {
    jobRoleId: role.id,
    data: {
      ...role.data,
      title: "Senior Software Engineer",
      requisitionId: "DEMO-001",
      status: "Open",
      openings: 2,
      targetDate: "2026-12-31",
    },
  });
  const names = [
    "Alex Example",
    "Sam Sample",
    "Jordan Demo",
    "Casey Fiction",
    "Taylor Test",
    "Morgan Placeholder",
  ];
  for (let i = 0; i < names.length; i++) {
    const candidate = await createRecord(p, "candidates", {
      data: {
        name: names[i],
        email: `candidate${i + 1}@example.test`,
        jobTitle: i % 2 ? "Product Designer" : "Software Engineer",
        yearsExperience: i + 1,
        folderCategories: [i % 2 ? "Design" : "Engineering"],
        skills: i % 2 ? ["Figma", "Research"] : ["TypeScript", "React"],
        reviewStatus: i % 2 ? "Needs review" : "Reviewed",
      },
    });
    const app = await createRecord(p, "applications", {
      candidateId: candidate.id,
      vacancyId: vacancy.id,
      data: {
        stage: [
          "Sourced",
          "Screening",
          "Interview",
          "Offer",
          "Hired",
          "Rejected",
        ][i],
        source: "Fictional local seed",
      },
    });
    if (i === 2)
      await createRecord(p, "interviews", {
        applicationId: app.id,
        data: {
          title: "Engineering conversation",
          startAt: new Date(Date.now() + 86400000).toISOString(),
          minutes: 60,
          interviewer: "Demo Recruiter",
          status: "Scheduled",
        },
      });
    if (i === 3)
      await createRecord(p, "offers", {
        applicationId: app.id,
        data: {
          title: "Senior Engineer offer",
          amount: "25000",
          currency: "AED",
          status: "Draft",
        },
      });
    if (i === 4) {
      const onboarding = await createRecord(p, "onboarding", {
        applicationId: app.id,
        data: { status: "In progress", owner: "Demo Recruiter" },
      });
      await createRecord(p, "checklist", {
        onboardingId: onboarding.id,
        data: {
          title: "Welcome orientation",
          category: "Orientation",
          status: "Pending",
        },
      });
    }
  }
  console.log(
    `Fictional local workspace ready.\nEmail: ${email}\nPassword: ${password}\nUse only for local testing. Real CV storage remains unconfigured.`,
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Local seed failed.");
  process.exitCode = 1;
});
