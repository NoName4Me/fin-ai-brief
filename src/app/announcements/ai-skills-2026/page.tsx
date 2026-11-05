import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import {
  competitionSlogan,
  competitionTitle,
} from '../../../components/competition-announcement.tsx';
import { ReaderOutline } from '../../../components/reader-outline.tsx';
import { framework, intro, modules, schedule, scheduleNote } from './training.ts';
import styles from './page.module.css';

export const metadata = { title: competitionTitle, description: '复赛阶段培训计划' };

const outline = [
  { id: 'training-plan', label: '复赛阶段培训计划' },
  { id: 'framework', label: '课程总体框架' },
  { id: 'schedule', label: '培训日程安排建议' },
  { id: 'syllabus', label: '分模块教学大纲' },
];

export default function CompetitionAnnouncementPage() {
  return (
    <main className={styles.page}>
      <Link href="/" className={styles.back}>
        <ArrowLeft size={16} aria-hidden="true" /> 返回首页
      </Link>
      <nav className={styles.toc} aria-label="公告目录">
        <p className="context-head">目录</p>
        <ReaderOutline items={outline} />
      </nav>
      <article className={styles.article}>
        <header className={styles.header}>
          <h1>{competitionTitle}</h1>
          <p>{competitionSlogan}</p>
          <Image
            src="/ai-ali.png"
            width={1721}
            height={914}
            sizes="(max-width: 920px) 100vw, (max-width: 1140px) 76vw, 872px"
            alt="中国东方与阿里云联合活动海报，启动动员会日期为2026年7月31日。"
            className={styles.cover}
          />
        </header>
        <section className={styles.content}>
          <h2 id="training-plan">复赛阶段培训计划</h2>
          <p>{intro}</p>

          <h3 id="framework">课程总体框架</h3>
          <table className={styles.table} aria-labelledby="framework">
            <thead>
              <tr>
                <th scope="col">课程主题</th>
                <th scope="col">课时</th>
                <th scope="col">学习成果</th>
              </tr>
            </thead>
            <tbody>
              {framework.map(([module, title, hours, outcome]) => (
                <tr key={module}>
                  <th scope="row">{title}</th>
                  <td>{hours}</td>
                  <td>{outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 id="schedule">培训日程安排建议</h3>
          <table className={styles.table} aria-labelledby="schedule">
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">培训内容</th>
                <th scope="col">课时</th>
              </tr>
            </thead>
            <tbody>
              {schedule.map(([week, session, topic, hours, date, time]) => (
                <tr key={session}>
                  <td className={styles.slot}>
                    {date}
                    <br />
                    {time}
                  </td>
                  <th scope="row">
                    <span className={styles.session}>
                      {week} · {session}
                    </span>
                    {topic}
                  </th>
                  <td>{hours}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={styles.note}>{scheduleNote}</p>

          <h3 id="syllabus">分模块教学大纲</h3>
          {modules.map(({ title, sections }) => (
            <details className={styles.module} key={title} open>
              <summary>{title}</summary>
              <dl>
                {sections.map(([label, paragraphs]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>
                      {paragraphs.map((paragraph) => {
                        if (!paragraph.startsWith('（1）')) {
                          return <p key={paragraph}>{paragraph}</p>;
                        }
                        const points = paragraph.split(/(?:^|；)（\d+）/).filter(Boolean);
                        return (
                          <ol key={paragraph}>
                            {points.map((point) => (
                              <li key={point}>{point}</li>
                            ))}
                          </ol>
                        );
                      })}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ))}
        </section>
      </article>
    </main>
  );
}
