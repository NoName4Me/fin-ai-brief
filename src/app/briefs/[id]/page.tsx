import { notFound } from 'next/navigation';
import { z } from 'zod';
import { ReaderShell } from '../../../components/reader-shell.tsx';
import { Brief } from '../../../components/brief.tsx';
import { publicIndustries, publishedBrief } from '../../../server/publication.ts';
import { kindSchema } from '../../../server/types.ts';
export default async function Issue({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [issue, industries] = await Promise.all([publishedBrief(id), publicIndustries()]);
  if (!issue?.content) notFound();
  return (
    <ReaderShell kind={kindSchema.parse(issue.kind)} currentId={id}>
      <Brief
        content={issue.content}
        kind={kindSchema.parse(issue.kind)}
        date={issue.periodDate}
        issueNumber={issue.issueNumber}
        industries={industries}
      />
    </ReaderShell>
  );
}
