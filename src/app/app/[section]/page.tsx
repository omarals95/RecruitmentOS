import { notFound } from "next/navigation";
import { RecordsScreen } from "@/components/workspace/records-screen";
import {
  ActivityScreen,
  Analytics,
  Notifications,
} from "@/components/workspace/overview";
import { CalendarScreen } from "@/components/workspace/calendar";
const sections = [
  "candidates",
  "shortlist",
  "vacancies",
  "roles",
  "pipeline",
  "tasks",
  "offers",
  "onboarding",
  "source-review",
];
export default async function SectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (section === "analytics") return <Analytics />;
  if (section === "insights") return <Analytics talent />;
  if (section === "activity") return <ActivityScreen />;
  if (section === "notifications") return <Notifications />;
  if (section === "interviews") return <CalendarScreen />;
  if (sections.includes(section))
    return <RecordsScreen key={section} section={section} />;
  notFound();
}
