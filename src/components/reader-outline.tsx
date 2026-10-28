'use client';
import { useEffect, useState } from 'react';
export function ReaderOutline({ items }: { items: { id: string; label: string }[] }) {
  const [active, setActive] = useState(items[0]?.id ?? '');
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const targets = items
        .map((item) => ({ id: item.id, node: document.getElementById(item.id) }))
        .filter((item) => item.node);
      if (!targets.length) return;
      const offset = Math.min(160, window.innerHeight * 0.2);
      let selected = targets[0].id;
      for (const target of targets)
        if (target.node!.getBoundingClientRect().top <= offset) selected = target.id;
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2)
        selected = targets.at(-1)!.id;
      setActive(selected);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    const article = document.querySelector('.daily-workspace .report-view');
    if (article) observer.observe(article);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [items]);
  return (
    <ul className="outline-list">
      {items.map((item) => (
        <li key={item.id}>
          <a href={`#${item.id}`} aria-current={active === item.id ? 'location' : undefined}>
            {item.label}
          </a>
        </li>
      ))}
    </ul>
  );
}
