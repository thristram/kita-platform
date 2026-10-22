import { redirect } from "next/navigation";

export default async function CandidatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/candidates/${id}/overview`);
}
