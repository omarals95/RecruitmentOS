import { CandidateProfile } from "@/components/workspace/candidate-profile";
export default async function CandidatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CandidateProfile id={id} />;
}
