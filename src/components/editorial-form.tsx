'use client';

import { useRef, useState } from 'react';
import { Switch } from './switch.tsx';
import type { Settings } from '../server/types.ts';
import { normalizedRatingRules, type SectionRule, type RatingRule } from '../server/editorial.ts';
import { editorialAction } from '../app/actions.ts';

const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
function parseWeekdays(value: string) {
  const tokens = value
    .trim()
    .split(/[、,，\s]+/)
    .map((s) => s.replace(/^(周|星期)/, ''));
  const values = tokens.map((s) =>
    /^[0-6]$/.test(s) ? Number(s) : weekdays.indexOf(s === '天' ? '日' : s),
  );
  return values.length && values.every((v) => v >= 0) ? [...new Set(values)] : null;
}
export function EditorialForm({
  config,
  section = 'all',
}: {
  config: Settings;
  section?: 'columns' | 'ratings' | 'content' | 'all';
}) {
  const showColumns = section === 'columns' || section === 'all';
  const showRatings = section === 'ratings' || section === 'all';
  const showContent = section === 'content' || section === 'all';
  const [sections, setSections] = useState(config.sections);
  const [highlightsDeleted, setHighlightsDeleted] = useState(config.highlightsDeleted);
  const [relaxationEnabled, setRelaxationEnabled] = useState(config.ratingRelaxationEnabled);
  const [relaxationMaxDrop, setRelaxationMaxDrop] = useState(
    String(config.ratingRelaxationMaxDrop),
  );
  const [ratings, setRatings] = useState(config.ratingRules);
  const [error, setError] = useState('');
  const dragging = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  function moveSection(id: string, target: string) {
    if (id === target) return;
    setSections((rows) => {
      const from = rows.findIndex((s) => s.id === id);
      const to = rows.findIndex((s) => s.id === target);
      if (from < 0 || to < 0) return rows;
      const next = [...rows];
      const [row] = next.splice(from, 1);
      next.splice(to, 0, row);
      return next;
    });
  }
  const shares = normalizedRatingRules(ratings);
  function updateSection(id: string, patch: Partial<SectionRule>) {
    setSections((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function updateRating(id: string, patch: Partial<RatingRule>) {
    setRatings((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function addSection() {
    setSections([
      ...sections,
      {
        id: crypto.randomUUID(),
        name: '新栏目',
        aliases: [],
        kind: 'fixed',
        enabled: true,
        description: '',
        keywords: '',
        minItems: 1,
        maxItems: 3,
        budget: 300,
        weekdays: [1],
        intervalWeeks: 1,
        anchorDate: config.startDate,
        lookbackDays: 7,
      },
    ]);
  }
  function addRating() {
    setRatings([
      ...ratings,
      {
        id: `metric_${crypto.randomUUID().replaceAll('-', '')}`,
        name: '新指标',
        description: '',
        weight: 10,
        enabled: true,
      },
    ]);
  }
  return (
    <form
      action={editorialAction}
      className="stack-form editorial-form"
      onSubmit={(event) => {
        let message = '';
        if (showRatings && !shares.length) message = '至少启用一个评分指标';
        else if (showColumns && !sections.some((s) => s.kind === 'fixed' && s.enabled))
          message = '至少保留一个启用的固定栏目';
        else if (
          showColumns &&
          new Set(sections.map((s) => s.name.trim())).size !== sections.length
        )
          message = '栏目名称不能重复';
        else if (showRatings && new Set(ratings.map((s) => s.name.trim())).size !== ratings.length)
          message = '评分指标名称不能重复';
        if (message) {
          event.preventDefault();
          setError(message);
        } else setError('');
      }}
    >
      <input type="hidden" name="editorialSection" value={section} />
      {showColumns && <input type="hidden" name="sections" value={JSON.stringify(sections)} />}
      {showRatings && <input type="hidden" name="ratingRules" value={JSON.stringify(ratings)} />}
      {showColumns && (
        <section aria-label="栏目与篇幅" className="editorial-group">
          <input type="hidden" name="highlightsConfig" value="1" />
          <input type="hidden" name="highlightsDeleted" value={String(highlightsDeleted)} />
          <header className="editorial-group-header column-actions">
            <button
              type="button"
              className="solid-button"
              onClick={addSection}
              disabled={sections.length >= 30}
            >
              新增栏目
            </button>
            {highlightsDeleted && (
              <button
                type="button"
                className="quiet-button"
                onClick={() => setHighlightsDeleted(false)}
              >
                恢复要览
              </button>
            )}
          </header>
          <div
            className="table-wrap editorial-table-wrap"
            role="region"
            aria-label="栏目配置"
            tabIndex={0}
          >
            <table className="editorial-columns-table">
              <thead>
                <tr>
                  {[
                    '排序',
                    '栏目名称',
                    '类型',
                    '启用',
                    '条数／引用数',
                    '字数预算',
                    '栏目要求',
                    '辅助关键词',
                    '轮动排期',
                    '操作',
                  ].map((name) => (
                    <th key={name} scope="col">
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!highlightsDeleted && (
                  <tr data-column-kind="highlights">
                    <td>
                      <span className="muted">—</span>
                    </td>
                    <td>
                      <input
                        aria-label="今日要览名称"
                        name="highlightsName"
                        maxLength={40}
                        defaultValue={config.highlightsName}
                        required
                      />
                    </td>
                    <td>要览</td>
                    <td>
                      <input
                        aria-label="今日要览启用"
                        type="checkbox"
                        name="highlightsEnabled"
                        defaultChecked={config.highlightsEnabled}
                      />
                    </td>
                    <td>
                      <div className="editorial-range">
                        <input
                          aria-label="今日要览下限"
                          type="number"
                          name="highlightsMinItems"
                          min={0}
                          max={10}
                          defaultValue={config.highlightsMinItems}
                          required
                        />
                        <span>—</span>
                        <input
                          aria-label="今日要览上限"
                          type="number"
                          name="highlightsMaxItems"
                          min={1}
                          max={10}
                          defaultValue={config.highlightsMaxItems}
                          required
                        />
                      </div>
                    </td>
                    <td>
                      <input
                        aria-label="今日要览字数预算"
                        type="number"
                        name="highlightsBudget"
                        min={1}
                        max={2000}
                        defaultValue={config.highlightsBudget}
                        required
                      />
                    </td>
                    <td>
                      <textarea
                        aria-label="今日要览栏目要求"
                        name="highlightsPrompt"
                        rows={2}
                        maxLength={2000}
                        defaultValue={config.highlightsPrompt}
                      />
                    </td>
                    <td>
                      <span className="muted">—</span>
                    </td>
                    <td>
                      <span className="muted">每日</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="quiet-button"
                        aria-label="今日要览删除"
                        onClick={() => setHighlightsDeleted(true)}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                )}
                {sections.map((section) => (
                  <tr
                    key={section.id}
                    data-column-id={section.id}
                    data-drop-target={dropTarget === section.id || undefined}
                    onDragOver={(event) => {
                      if (dragging.current) {
                        event.preventDefault();
                        setDropTarget(section.id);
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (dragging.current) moveSection(dragging.current, section.id);
                      dragging.current = null;
                      setDropTarget(null);
                    }}
                  >
                    <td>
                      <button
                        type="button"
                        className="column-drag-handle"
                        draggable
                        aria-label={`${section.name}排序，使用上下方向键调整`}
                        onDragStart={(event) => {
                          dragging.current = section.id;
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', section.id);
                        }}
                        onDragEnd={() => {
                          dragging.current = null;
                          setDropTarget(null);
                        }}
                        onKeyDown={(event) => {
                          if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                          event.preventDefault();
                          const index = sections.findIndex((s) => s.id === section.id);
                          const target = sections[index + (event.key === 'ArrowUp' ? -1 : 1)];
                          if (target) moveSection(section.id, target.id);
                        }}
                        onPointerDown={(event) => {
                          if (event.pointerType !== 'touch') return;
                          dragging.current = section.id;
                          event.currentTarget.setPointerCapture(event.pointerId);
                        }}
                        onPointerMove={(event) => {
                          if (event.pointerType !== 'touch' || dragging.current !== section.id)
                            return;
                          const row = document
                            .elementFromPoint(event.clientX, event.clientY)
                            ?.closest<HTMLElement>('tr[data-column-id]');
                          if (row?.dataset.columnId) moveSection(section.id, row.dataset.columnId);
                        }}
                        onPointerUp={(event) => {
                          if (event.pointerType === 'touch') {
                            dragging.current = null;
                            if (event.currentTarget.hasPointerCapture(event.pointerId))
                              event.currentTarget.releasePointerCapture(event.pointerId);
                          }
                        }}
                        onPointerCancel={() => {
                          dragging.current = null;
                        }}
                      >
                        <svg
                          width="16"
                          height="20"
                          viewBox="0 0 16 20"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          {[5, 10, 15].flatMap((y) =>
                            [5, 11].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" />),
                          )}
                        </svg>
                      </button>
                    </td>
                    <td>
                      <input
                        aria-label={`${section.name}名称`}
                        value={section.name}
                        maxLength={40}
                        required
                        onChange={(e) => updateSection(section.id, { name: e.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        aria-label={`${section.name}类型`}
                        value={section.kind}
                        onChange={(e) =>
                          updateSection(section.id, { kind: e.target.value as SectionRule['kind'] })
                        }
                      >
                        <option value="fixed">固定</option>
                        <option value="rotation">轮动</option>
                      </select>
                    </td>
                    <td>
                      <input
                        aria-label={`${section.name}启用`}
                        type="checkbox"
                        checked={section.enabled}
                        onChange={(e) => updateSection(section.id, { enabled: e.target.checked })}
                      />
                    </td>
                    <td>
                      <div className="editorial-range">
                        <input
                          aria-label={`${section.name}下限`}
                          type="number"
                          min={0}
                          max={section.maxItems}
                          required
                          value={section.minItems}
                          onChange={(e) =>
                            updateSection(section.id, { minItems: Number(e.target.value) })
                          }
                        />
                        <span>—</span>
                        <input
                          aria-label={`${section.name}上限`}
                          type="number"
                          min={Math.max(1, section.minItems)}
                          max={20}
                          required
                          value={section.maxItems}
                          onChange={(e) =>
                            updateSection(section.id, { maxItems: Number(e.target.value) })
                          }
                        />
                      </div>
                    </td>
                    <td>
                      <input
                        aria-label={`${section.name}字数预算`}
                        type="number"
                        min={50}
                        max={3000}
                        required
                        value={section.budget}
                        onChange={(e) =>
                          updateSection(section.id, { budget: Number(e.target.value) })
                        }
                      />
                    </td>
                    <td>
                      <textarea
                        aria-label={`${section.name}栏目要求`}
                        rows={2}
                        value={section.description}
                        maxLength={2000}
                        onChange={(e) => updateSection(section.id, { description: e.target.value })}
                      />
                    </td>
                    <td>
                      <textarea
                        aria-label={`${section.name}辅助关键词`}
                        rows={2}
                        value={section.keywords}
                        maxLength={2000}
                        onChange={(e) => updateSection(section.id, { keywords: e.target.value })}
                      />
                    </td>
                    <td>
                      {section.kind === 'rotation' ? (
                        <div className="editorial-schedule">
                          <label>
                            每
                            <input
                              aria-label={`${section.name}间隔周数`}
                              type="number"
                              min={1}
                              max={52}
                              required
                              value={section.intervalWeeks}
                              onChange={(e) =>
                                updateSection(section.id, { intervalWeeks: Number(e.target.value) })
                              }
                            />
                            周
                          </label>
                          <input
                            aria-label={`${section.name}出刊星期`}
                            required
                            defaultValue={section.weekdays
                              .map((d) => `周${weekdays[d]}`)
                              .join('、')}
                            onChange={(e) => {
                              const days = parseWeekdays(e.target.value);
                              e.currentTarget.setCustomValidity(
                                days ? '' : '填写周一、周三等出刊星期',
                              );
                              if (days) updateSection(section.id, { weekdays: days });
                            }}
                          />
                        </div>
                      ) : (
                        <span className="muted">每日</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="quiet-button"
                        aria-label={`${section.name}删除`}
                        onClick={() =>
                          setSections((rows) => rows.filter((s) => s.id !== section.id))
                        }
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="editorial-thresholds editorial-publication-limits">
            <label>
              字数超额容差（%）
              <input
                name="budgetTolerancePercent"
                type="number"
                min={0}
                max={50}
                defaultValue={config.budgetTolerancePercent}
                required
              />
            </label>
            <label>
              每期最多事件数
              <input
                name="maxItems"
                type="number"
                min={2}
                max={50}
                defaultValue={config.maxItems}
                required
              />
            </label>
            <label>
              简报主标题字数上限
              <input
                name="briefTitleMaxLength"
                type="number"
                min={1}
                max={200}
                defaultValue={config.briefTitleMaxLength}
                required
              />
            </label>
          </div>
        </section>
      )}
      {showRatings && (
        <section aria-label="评分规则" className="editorial-group">
          <header className="editorial-group-header column-actions">
            <button
              type="button"
              className="solid-button"
              onClick={addRating}
              disabled={ratings.length >= 30}
            >
              新增指标
            </button>
          </header>
          <div
            className="table-wrap editorial-table-wrap"
            role="region"
            aria-label="评分指标配置"
            tabIndex={0}
          >
            <table className="editorial-ratings-table">
              <thead>
                <tr>
                  {['指标名称', '评分描述', '权重', '实际占比', '启用', '操作'].map((name) => (
                    <th key={name} scope="col">
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ratings.map((rule) => (
                  <tr key={rule.id} data-rating-id={rule.id}>
                    <td>
                      <input
                        aria-label={`${rule.name}名称`}
                        required
                        value={rule.name}
                        maxLength={40}
                        onChange={(e) => updateRating(rule.id, { name: e.target.value })}
                      />
                    </td>
                    <td>
                      <textarea
                        aria-label={`${rule.name}描述`}
                        rows={2}
                        required
                        maxLength={2000}
                        value={rule.description}
                        onChange={(e) => updateRating(rule.id, { description: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${rule.name}权重`}
                        type="number"
                        min={rule.enabled ? 0.01 : 0}
                        max={100}
                        step="0.01"
                        required
                        value={rule.weight}
                        onChange={(e) => updateRating(rule.id, { weight: Number(e.target.value) })}
                      />
                    </td>
                    <td className="editorial-share">
                      {rule.enabled
                        ? `${((shares.find((r) => r.id === rule.id)?.share ?? 0) * 100).toFixed(1)}%`
                        : '暂停'}
                    </td>
                    <td>
                      <Switch
                        size="small"
                        aria-label={`${rule.name}启用`}
                        checked={rule.enabled}
                        onCheckedChange={(enabled) => updateRating(rule.id, { enabled })}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="quiet-button"
                        aria-label={`${rule.name}删除`}
                        onClick={() => setRatings((rows) => rows.filter((r) => r.id !== rule.id))}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="editorial-thresholds editorial-rating-thresholds">
            <label>
              日报候选门槛
              <input
                name="candidateRating"
                type="number"
                min={1}
                max={5}
                step="0.01"
                required
                defaultValue={config.candidateRating}
              />
            </label>
            <label>
              要览候选门槛
              <input
                name="highlightRating"
                type="number"
                min={1}
                max={5}
                step="0.01"
                required
                defaultValue={config.highlightRating}
              />
            </label>
            <label className="check">
              <input
                name="ratingRelaxationEnabled"
                type="checkbox"
                checked={relaxationEnabled}
                onChange={(e) => setRelaxationEnabled(e.target.checked)}
              />
              内容不足时放宽门槛
            </label>
            {relaxationEnabled ? (
              <label>
                最多下调分数
                <input
                  name="ratingRelaxationMaxDrop"
                  type="number"
                  min={0.1}
                  max={1}
                  step="0.1"
                  value={relaxationMaxDrop}
                  onChange={(e) => setRelaxationMaxDrop(e.target.value)}
                  required
                />
              </label>
            ) : (
              <input type="hidden" name="ratingRelaxationMaxDrop" value={relaxationMaxDrop} />
            )}
          </div>
        </section>
      )}
      {showContent && (
        <>
          <label>
            收录与写作要求
            <textarea
              aria-label="收录与写作要求"
              name="editorialPrompt"
              rows={4}
              defaultValue={config.editorialPrompt}
              maxLength={6000}
            />
          </label>
          <label className="check">
            <input type="checkbox" name="reviewEnabled" defaultChecked={config.reviewEnabled} />
            启用疑难归组与事实复核
          </label>
        </>
      )}
      {error && (
        <p role="alert" className="source-toggle-error">
          {error}
        </p>
      )}
      <button className="solid-button">保存</button>
    </form>
  );
}
