import type { Metadata } from 'next';
import './globals.css';
import { Header } from '../components/navigation.tsx';
export const metadata: Metadata = {
  title: { default: '数智参阅', template: '%s · 数智参阅' },
  description: 'AI发展、治理与产业资讯',
};
export const dynamic = 'force-dynamic';
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth">
      <body className="ink-paper dual-edition">
        <Header />
        {children}
      </body>
    </html>
  );
}
