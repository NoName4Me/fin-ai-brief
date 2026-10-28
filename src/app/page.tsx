import { ReaderShell } from '../components/reader-shell.tsx';
import { Brief } from '../components/brief.tsx';
import { Empty } from '../components/notice.tsx';
import { listPublished, publicIndustries } from '../server/publication.ts';
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await searchParams;
  const kind = 'daily';
  const [issues, industries] = await Promise.all([listPublished(kind), publicIndustries()]);
  const issue = issues[0];
  return (
    <ReaderShell kind={kind} currentId={issue?.id}>
      {issue?.content ? (
        <Brief
          content={issue.content}
          kind={kind}
          date={issue.periodDate}
          issueNumber={issue.issueNumber}
          industries={industries}
        />
      ) : (
        <Empty>
          <h1>数智参阅</h1>
          <p>本类型尚无正式简报。发布后会在这里展示。</p>
        </Empty>
      )}
    </ReaderShell>
  );
}
