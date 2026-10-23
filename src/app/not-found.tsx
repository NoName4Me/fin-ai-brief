import Link from 'next/link';
export default function NotFound() {
  return (
    <main className="form-page">
      <h1>未找到页面</h1>
      <p>简报可能尚未发布，或链接有误。</p>
      <Link href="/">返回简报中心</Link>
    </main>
  );
}
