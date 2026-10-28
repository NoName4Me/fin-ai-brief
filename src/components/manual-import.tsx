import { articleAction } from '../app/actions.ts';
export function ManualImport() {
  return (
    <form action={articleAction} className="stack-form">
      <label>
        标题
        <input name="title" required maxLength={500} />
      </label>
      <label>
        原文链接
        <input type="url" name="url" required />
      </label>
      <label>
        来源名称
        <input name="sourceName" required maxLength={200} />
      </label>

      <label>
        发布时间（北京时间）
        <input type="datetime-local" name="publishedAt" required />
      </label>
      <label>
        摘要
        <textarea name="excerpt" required maxLength={16000} rows={6} />
      </label>
      <button className="solid-button">录入资讯</button>
    </form>
  );
}
