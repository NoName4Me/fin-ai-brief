import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import styles from './competition-announcement.module.css';

export const competitionTitle = '2026年中国东方AI赋能金融技能大赛复赛阶段培训计划';
export const competitionSlogan = '智汇东方·创未来';

export function CompetitionAnnouncement() {
  return (
    <Link
      href="/announcements/ai-skills-2026"
      className={styles.entry}
      aria-label={`查看公告：${competitionTitle}，${competitionSlogan}`}
    >
      <div className={styles.inner} aria-hidden="true">
        <div className={styles.headlines}>
          <Image
            src="/ai-competition-slogan.webp"
            alt=""
            width={660}
            height={118}
            unoptimized
            className={styles.slogan}
          />
          <p className={styles.title}>{competitionTitle}</p>
        </div>
        <span className={styles.action}>
          查看公告 <ArrowRight size={13} aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}
