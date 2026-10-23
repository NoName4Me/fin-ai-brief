import { requireAdmin } from '../../../../server/auth.ts';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../../server/db.ts';
import { briefs } from '../../../../server/schema.ts';
import { publicIndustries } from '../../../../server/publication.ts';
import { kindSchema } from '../../../../server/types.ts';
import { Brief } from '../../../../components/brief.tsx';
import { publishAction } from '../../../actions.ts';
export default async function Review({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [row] = await db.select().from(briefs).where(eq(briefs.id, id));
  if (!row?.draft) notFound();
  return (
    <>
      <div className="review-toolbar">
        <p>待审核稿，仅管理员可读。</p>
        <form action={publishAction}>
          <input type="hidden" name="id" value={id} />
          <button className="solid-button">审核并发布</button>
        </form>
      </div>
      <Brief
        content={row.draft}
        kind={kindSchema.parse(row.kind)}
        date={row.periodDate}
        issueNumber={row.issueNumber}
        industries={await publicIndustries()}
      />
    </>
  );
}
