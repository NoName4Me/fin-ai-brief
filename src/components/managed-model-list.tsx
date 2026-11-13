'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { GripVertical } from 'lucide-react';
import { modelPrimaryAction, modelReorderAction, modelToggleAction } from '../app/actions.ts';
import { ManagedModelTest } from './managed-model-test.tsx';

export interface ManagedModelListItem {
  id: string;
  name: string;
  enabled: boolean;
  model: string;
  total: number;
  failed: number;
  avgLatency: number | null;
}

export function ManagedModelList({
  models,
  returnTo,
}: {
  models: ManagedModelListItem[];
  returnTo: string;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(models);
  const rowsRef = useRef(rows);
  const editSequence = useRef(0);
  const dragging = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setReady(true);
    setRows(models);
    rowsRef.current = models;
  }, [models]);

  function reorder(sourceId: string, targetId: string, persist = true) {
    if (sourceId === targetId || sourceId === rowsRef.current[0]?.id) return;
    const next = [...rowsRef.current];
    const from = next.findIndex((model) => model.id === sourceId);
    const to = next.findIndex((model) => model.id === targetId);
    if (from <= 0 || to <= 0) return;
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    rowsRef.current = next;
    setRows(next);
    if (persist) void saveOrder(next);
  }

  function saveOrder(next: ManagedModelListItem[]) {
    const form = new FormData();
    for (const model of next) form.append('id', model.id);
    setError('');
    startTransition(async () => {
      const result = await modelReorderAction(form);
      if (result.ok) router.refresh();
      else {
        setError(result.error);
        setRows(models);
        rowsRef.current = models;
      }
    });
  }

  function finishTouch(event: React.PointerEvent<HTMLButtonElement>, sourceId: string) {
    if (event.pointerType !== 'touch' || dragging.current !== sourceId) return;
    dragging.current = null;
    setDropTarget(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (rowsRef.current !== models) saveOrder(rowsRef.current);
  }

  return (
    <>
      {error && (
        <p className="model-list-error" role="alert">
          {error}
        </p>
      )}
      <div className="model-table-scroll">
        <table className="model-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>角色</th>
              <th>本周期</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((model, index) => {
              const primary = index === 0;
              const role = !model.enabled ? 'paused' : primary ? 'primary' : 'backup';
              const roleLabel = role === 'primary' ? '主力' : role === 'backup' ? '备用' : '已停用';
              const editParams = new URLSearchParams(returnTo.split('?')[1] ?? '');
              editParams.set('edit', model.id);
              const successRate =
                model.total > 0
                  ? `${Math.round(((model.total - model.failed) / model.total) * 100)}%`
                  : '—';
              return (
                <tr
                  key={model.id}
                  data-model-id={model.id}
                  data-drop-target={dropTarget === model.id || undefined}
                  onDragOver={(event) => {
                    if (
                      !primary &&
                      (dragging.current || event.dataTransfer.types.includes('text/plain'))
                    ) {
                      event.preventDefault();
                      setDropTarget(model.id);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const source = dragging.current || event.dataTransfer.getData('text/plain');
                    dragging.current = null;
                    setDropTarget(null);
                    if (source) reorder(source, model.id);
                  }}
                >
                  <td>
                    <div className="model-name-cell">
                      <button
                        type="button"
                        className="model-drag-handle"
                        data-ready={ready}
                        draggable={!primary && !pending}
                        disabled={primary || pending || !ready}
                        title={primary ? '主力模型固定在首位' : '拖拽调整备用顺序'}
                        aria-label={
                          primary
                            ? `${model.name}为主力模型，固定在首位`
                            : `${model.name}排序，拖拽或使用上下方向键调整`
                        }
                        onDragStart={(event) => {
                          dragging.current = model.id;
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', model.id);
                        }}
                        onDragEnd={() => {
                          dragging.current = null;
                          setDropTarget(null);
                        }}
                        onKeyDown={(event) => {
                          if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                          event.preventDefault();
                          const target = rows[index + (event.key === 'ArrowUp' ? -1 : 1)];
                          if (target) reorder(model.id, target.id);
                        }}
                        onPointerDown={(event) => {
                          if (event.pointerType !== 'touch' || primary) return;
                          dragging.current = model.id;
                          event.currentTarget.setPointerCapture(event.pointerId);
                        }}
                        onPointerMove={(event) => {
                          if (event.pointerType !== 'touch' || dragging.current !== model.id)
                            return;
                          const row = document
                            .elementFromPoint(event.clientX, event.clientY)
                            ?.closest<HTMLElement>('tr[data-model-id]');
                          const target = row?.dataset.modelId;
                          if (target) reorder(model.id, target, false);
                        }}
                        onPointerUp={(event) => finishTouch(event, model.id)}
                        onPointerCancel={() => {
                          dragging.current = null;
                          setDropTarget(null);
                        }}
                      >
                        <GripVertical className="icon" strokeWidth={1.5} aria-hidden="true" />
                      </button>
                      <div>
                        <strong>{model.name}</strong>
                        <small>{model.model || '未填写模型名称'}</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`model-role role-${role}`}>{roleLabel}</span>
                  </td>
                  <td className="model-stat-cell">
                    <strong>{successRate}</strong>
                    <small>
                      {model.failed} 异常 / {model.total} 次
                    </small>
                    {model.avgLatency !== null && <small>{model.avgLatency}ms</small>}
                  </td>
                  <td>
                    <div className="model-row-actions">
                      <ManagedModelTest id={model.id} />
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          editParams.set('event', `${Date.now()}-${++editSequence.current}`);
                          void router.push(`/admin/models?${editParams.toString()}`, {
                            scroll: false,
                          });
                        }}
                      >
                        编辑
                      </button>
                      <form action={modelToggleAction}>
                        <input type="hidden" name="id" value={model.id} />
                        <input
                          type="hidden"
                          name="enabled"
                          value={model.enabled ? 'false' : 'true'}
                        />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <button className="text-button" type="submit">
                          {model.enabled ? '暂停' : '启用'}
                        </button>
                      </form>
                      {!primary && model.enabled && (
                        <form action={modelPrimaryAction}>
                          <input type="hidden" name="id" value={model.id} />
                          <input type="hidden" name="returnTo" value={returnTo} />
                          <button className="text-button" type="submit">
                            设为主力
                          </button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
