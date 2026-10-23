import { requireAdmin } from '../../../server/auth.ts';
import { db } from '../../../server/db.ts';
import { industries } from '../../../server/schema.ts';
import { industryAction, industryRemoveAction } from '../../actions.ts';
import { Notice, type Query } from '../../../components/notice.tsx';
function Fields({ row }: { row?: typeof industries.$inferSelect }) {
  return (
    <>
      <label>
        标识
        <input
          name="id"
          defaultValue={row?.id}
          readOnly={Boolean(row)}
          required
          pattern="[a-z][a-z0-9_-]*"
          placeholder="例如 finance"
        />
      </label>
      <label>
        行业名称
        <input name="name" defaultValue={row?.name} required maxLength={40} />
      </label>
      <label>
        关注范围
        <textarea name="description" defaultValue={row?.description} required maxLength={2000} />
      </label>
      <label>
        栏目（每行一个）
        <textarea name="sections" defaultValue={row?.sections.join('\n')} required />
      </label>
      <label>
        排序
        <input type="number" min={0} max={100} name="position" defaultValue={row?.position ?? 0} />
      </label>
      <button className="solid-button">{row ? '保存行业' : '添加行业'}</button>
    </>
  );
}
export default async function Industries({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const rows = await db.select().from(industries).orderBy(industries.position);
  return (
    <>
      <Notice query={await searchParams} />
      {rows.map((row) => (
        <details key={row.id} className="admin-section">
          <summary>
            {row.name}　<span className="muted">{row.sections.join(' / ')}</span>
          </summary>
          <form action={industryAction} className="stack-form">
            <Fields row={row} />
          </form>
          <form action={industryRemoveAction}>
            <input type="hidden" name="id" value={row.id} />
            <button className="quiet-button">删除未使用行业</button>
          </form>
        </details>
      ))}
      <details className="admin-section">
        <summary>添加行业</summary>
        <form action={industryAction} className="stack-form">
          <Fields />
        </form>
      </details>
    </>
  );
}
