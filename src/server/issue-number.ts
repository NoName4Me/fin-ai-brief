import { sql } from 'drizzle-orm';
import type { db } from './db.ts';
import type { Kind } from './types.ts';
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function assignIssueNumber(tx: Transaction, id: string, kind: Kind, date: string) {
  const year = Number(date.slice(0, 4));
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`issue-number:${kind}:${year}`}))`);
  await tx.execute(sql`UPDATE briefs SET issue_number=(
    SELECT coalesce(max(issue_number),0)+1 FROM briefs
    WHERE kind=${kind} AND period_date>=${`${year}-01-01`}::date AND period_date<${`${year + 1}-01-01`}::date
  ) WHERE id=${id}::uuid AND issue_number IS NULL`);
}
