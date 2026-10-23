import type { Metadata } from 'next';
import './globals.css';
import { Header } from '../components/navigation.tsx';
export const metadata: Metadata = {
  title: { default: 'Fin&AI简报', template: '%s · Fin&AI简报' },
  description: '金融与AI资讯简报',
};
export const dynamic = 'force-dynamic';
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="ink-paper dual-edition">
        <Header />
        {children}
      </body>
    </html>
  );
}
