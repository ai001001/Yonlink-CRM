/**
 * 销售节奏的共用界面：读取节奏、步骤说明、“加入销售节奏”下拉（列表批量栏与详情抽屉共用）、记录详情中的参与面板。
 * Shared cadence UI: loading cadences, step descriptions, the "Enroll in cadence" picker (bulk bar and drawers) and
 * the enrollment panel in record details.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, List, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

/** 适用对象 / module */
export type CadenceEntity = 'LEAD' | 'DEAL';
/** 步骤 / step */
export interface CadenceStep {
  day: number;
  type: 'CALL' | 'MEETING' | 'VISIT' | 'TASK';
  subject: string;
}
/** 节奏 / cadence */
export interface Cadence {
  id: string;
  name: string;
  description: string | null;
  entity: CadenceEntity;
  isActive: boolean;
  steps: CadenceStep[];
  exitStates: string[];
  counts: { active: number; completed: number; exited: number; stopped: number };
}
/** 参与 / enrollment */
interface Enrollment {
  id: string;
  status: 'ACTIVE' | 'COMPLETED' | 'EXITED' | 'STOPPED';
  currentStep: number;
  nextDueAt: string | null;
  enrolledAt: string;
  endedAt: string | null;
  endReason: string | null;
  cadence: { id: string; name: string; stepCount: number };
  enrolledBy: { id: string; name: string };
}
/** 批量结果 / bulk result */
interface BulkResult {
  succeeded: string[];
  failed: { id: string; code: string; message: string }[];
}

/** 状态的枚举前缀 / enum prefix of states */
export const CADENCE_STATE_PREFIX: Record<CadenceEntity, string> = { LEAD: 'leadStatus', DEAL: 'dealStage' };
/** 步骤说明 / describe a step */
export const stepText = (s: CadenceStep) => t('cadences.stepText', { day: s.day, type: tEnum('activityType', s.type), subject: s.subject });

/**
 * 读取节奏（可按对象）。
 * Load cadences (optionally by module).
 */
export function useCadences(entity?: CadenceEntity) {
  const [items, setItems] = useState<Cadence[]>([]);
  const reload = useCallback(() => {
    api<{ items: Cadence[] }>(`/api/cadences${entity ? `?entity=${entity}` : ''}`)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, [entity]);
  useEffect(reload, [reload]);
  return { items, reload };
}

/**
 * “加入销售节奏”下拉：只列出启用的节奏；确认后加入并显示结果，有失败时逐条列出原因。
 * "Enroll in cadence" picker: active cadences only; confirm, enroll and show the result with per-record failures.
 */
export function CadenceEnroller({ entity, ids, names, onDone }: { entity: CadenceEntity; ids: string[]; names: Record<string, string>; onDone: () => void }) {
  const { message, modal } = App.useApp();
  const { items } = useCadences(entity);
  const active = items.filter((c) => c.isActive);

  const run = async (c: Cadence) => {
    try {
      const res = await api<BulkResult>(`/api/cadences/${c.id}/enroll`, { method: 'POST', body: { ids } });
      if (!res.failed.length) {
        message.success(t('cadences.enrolled', { n: res.succeeded.length, name: c.name }));
      } else {
        modal.warning({
          title: t('bulk.partial', { ok: res.succeeded.length, fail: res.failed.length }),
          content: (
            <div data-testid="cadence-failures">
              <Typography.Text type="secondary">{t('bulk.failedTitle')}</Typography.Text>
              <ul style={{ paddingLeft: 18, marginTop: 8 }}>
                {res.failed.map((f) => (
                  <li key={f.id}>
                    {names[f.id] ?? f.id.slice(0, 8)}
                    {t('common.colon')}
                    {t(`error.${f.code}` as MessageKey)}
                  </li>
                ))}
              </ul>
            </div>
          ),
        });
      }
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      onDone();
    }
  };

  return (
    <Select
      aria-label={t('cadences.enroll')}
      placeholder={t('cadences.enroll')}
      style={{ width: 170 }}
      value={null}
      data-testid="cadence-enroll"
      notFoundContent={t('cadences.noCadences')}
      options={active.map((c) => ({ value: c.id, label: c.name }))}
      onChange={(id: string) => {
        const c = active.find((x) => x.id === id);
        if (!c) return;
        modal.confirm({
          title: t('cadences.confirmEnroll', { n: ids.length, name: c.name }),
          content: t('cadences.enrollSteps', { list: c.steps.map(stepText).join(t('common.listSep')) }),
          okText: t('cadences.enroll'),
          cancelText: t('common.cancel'),
          onOk: () => run(c),
        });
      }}
    />
  );
}

/** 结束原因 / end reason */
function reasonText(entity: CadenceEntity, reason: string | null) {
  if (!reason || reason === 'completed' || reason === 'stopped') return null;
  if (reason === 'converted') return t('cadences.reason.converted');
  if (reason.startsWith('state:')) return t('cadences.reason.state', { state: tEnum(CADENCE_STATE_PREFIX[entity], reason.slice(6)) });
  return reason;
}

/**
 * 记录详情中的参与面板（没有参与时不显示）。
 * Enrollment panel in a record detail (hidden without enrollments).
 * @param version 记录变化后递增以重新读取 / bump to reload after the record changes
 */
export function CadencePanel({ entity, id, editable, version = 0 }: { entity: CadenceEntity; id: string; editable: boolean; version?: number }) {
  const { message } = App.useApp();
  const [items, setItems] = useState<Enrollment[]>([]);
  const load = useCallback(() => {
    api<{ items: Enrollment[] }>(`/api/cadence-enrollments?entity=${entity}&id=${id}`)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, [entity, id]);
  useEffect(load, [load, version]);
  if (!items.length) return null;

  const stop = async (e: Enrollment) => {
    try {
      await api(`/api/cadence-enrollments/${e.id}/stop`, { method: 'POST' });
      message.success(t('cadences.stopped'));
      load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <Card size="small" style={{ marginBottom: 16 }} title={t('cadences.panelTitle')} data-testid="cadence-panel">
      <List
        size="small"
        dataSource={items}
        renderItem={(e) => (
          <List.Item
            actions={
              e.status === 'ACTIVE' && editable
                ? [
                    <Popconfirm key="stop" title={t('cadences.confirmStop', { name: e.cadence.name })} onConfirm={() => void stop(e)}>
                      <Button size="small" danger>
                        {t('cadences.stop')}
                      </Button>
                    </Popconfirm>,
                  ]
                : []
            }
          >
            <Space wrap>
              <Typography.Text strong>{e.cadence.name}</Typography.Text>
              <Tag color={e.status === 'ACTIVE' ? 'processing' : e.status === 'COMPLETED' ? 'success' : 'default'}>{t(`cadences.status.${e.status}`)}</Tag>
              <span>{t('cadences.progress', { done: Math.min(e.currentStep, e.cadence.stepCount), total: e.cadence.stepCount })}</span>
              {e.nextDueAt && <Typography.Text type="secondary">{t('cadences.nextDue', { time: fmtDateTime(e.nextDueAt) })}</Typography.Text>}
              {reasonText(entity, e.endReason) && <Typography.Text type="secondary">{reasonText(entity, e.endReason)}</Typography.Text>}
            </Space>
          </List.Item>
        )}
      />
    </Card>
  );
}
