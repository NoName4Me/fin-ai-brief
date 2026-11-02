import { requireAdmin } from '../../../../server/auth.ts';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../../server/db.ts';
import { briefs } from '../../../../server/schema.ts';
import { publicIndustries } from '../../../../server/publication.ts';
import { kindSchema } from '../../../../server/types.ts';
import { BriefEditor } from '../../../../components/brief-editor.tsx';
import { revisionVersion } from '../../../../server/brief-editing.ts';
import { Notice, type Query } from '../../../../components/notice.tsx';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
export default async function Review({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Query>;
}) {
  await requireAdmin();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [row] = await db.select().from(briefs).where(eq(briefs.id, id));
  const query = await searchParams;
  const target =
    query.version === 'published' && row?.published
      ? 'published'
      : row?.draft
        ? 'draft'
        : 'published';
  const content = row?.[target];
  if (!content) notFound();
  return (
    <>
      <Notice query={query} />
      <div className="back-link brief-editor-back">
        <Link href="/admin/publications">
          <ArrowLeft className="icon" strokeWidth={1.75} aria-hidden="true" />
          取消
        </Link>
      </div>
      <BriefEditor
        key={id}
        id={id}
        initialContent={content}
        initialVersion={revisionVersion(row)}
        initialBase={target}
        initialHasPublished={!!row.published}
        kind={kindSchema.parse(row.kind)}
        date={row.periodDate}
        issueNumber={row.issueNumber}
        industries={await publicIndustries()}
      />
    </>
  );
}
