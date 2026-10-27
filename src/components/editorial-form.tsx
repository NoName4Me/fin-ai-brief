'use client';

import { useState } from 'react';
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
export function EditorialForm({ config }: { config: Settings }) {
  const [sections, setSections] = useState(config.sections);
  const [ratings, setRatings] = useState(config.ratingRules);
  const [error, setError] = useState('');
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
        minItems: 1,
        maxItems: 3,
        budget: 300,
        weekdays: [1],
        intervalWeeks: 1,
        anchorDate: '2026-10-26',
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
        if (!shares.length) message = '至少启用一个评分指标';
        else if (!sections.some((s) => s.kind === 'fixed' && s.enabled))
          message = '至少保留一个启用的固定栏目';
        else if (new Set(sections.map((s) => s.name.trim())).size !== sections.length)
          message = '栏目名称不能重复';
        else if (new Set(ratings.map((s) => s.name.trim())).size !== ratings.length)
          message = '评分指标名称不能重复';
        if (message) {
          event.preventDefault();
          setError(message);
        } else setError('');
      }}
    >
      <input type="hidden" name="sections" value={JSON.stringify(sections)} />
      <input type="hidden" name="ratingRules" value={JSON.stringify(ratings)} />
      <section aria-labelledby="columns-heading" className="editorial-group">
        <header className="editorial-group-header">
          <h2 id="columns-heading">栏目</h2>
          <button
            type="button"
            className="outline-button"
            onClick={addSection}
            disabled={sections.length >= 30}
          >
            新增栏目
          </button>
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
                  '栏目名称',
                  '类型',
                  '启用',
                  '条数／引用数',
                  '字数预算',
                  '栏目要求',
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
              {sections.map((section) => (
                <tr key={section.id} data-column-id={section.id}>
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
                          defaultValue={section.weekdays.map((d) => `周${weekdays[d]}`).join('、')}
                          onChange={(e) => {
                            const days = parseWeekdays(e.target.value);
                            e.currentTarget.setCustomValidity(
                              days ? '' : '填写周一、周三等出刊星期',
                            );
                            if (days) updateSection(section.id, { weekdays: days });
                          }}
                        />
                        <label>
                          取材
                          <input
                            aria-label={`${section.name}取材天数`}
                            type="number"
                            min={1}
                            max={365}
                            required
                            value={section.lookbackDays}
                            onChange={(e) =>
                              updateSection(section.id, { lookbackDays: Number(e.target.value) })
                            }
                          />
                          天
                        </label>
                        <label>
                          基准
                          <input
                            aria-label={`${section.name}排期基准日期`}
                            type="date"
                            required
                            value={section.anchorDate}
                            onChange={(e) =>
                              updateSection(section.id, { anchorDate: e.target.value })
                            }
                          />
                        </label>
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
                      onClick={() => setSections((rows) => rows.filter((s) => s.id !== section.id))}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="ratings-heading" className="editorial-group">
        <header className="editorial-group-header">
          <h2 id="ratings-heading">评分指标</h2>
          <button
            type="button"
            className="outline-button"
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
                    <input
                      aria-label={`${rule.name}启用`}
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => updateRating(rule.id, { enabled: e.target.checked })}
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
        <div className="editorial-thresholds">
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
        </div>
      </section>
      <label>
        标签
        <textarea name="tags" rows={3} defaultValue={config.tags.join('、')} maxLength={4000} />
      </label>
      <label>
        关键词监控
        <textarea name="keywords" rows={5} defaultValue={config.keywords} maxLength={6000} />
      </label>
      <label>
        收录与写作要求
        <textarea
          name="editorialPrompt"
          rows={4}
          defaultValue={config.editorialPrompt}
          maxLength={6000}
        />
      </label>
      {error && (
        <p role="alert" className="source-toggle-error">
          {error}
        </p>
      )}
      <button className="solid-button">保存栏目与选题</button>
    </form>
  );
}
