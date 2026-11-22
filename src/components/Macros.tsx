/**
 * 宏的共用界面：读取可用的宏、动作的文字说明、“运行宏”下拉（列表批量栏与详情抽屉共用）。
 * Shared macro UI: loading available macros, action descriptions and the "Run macro" picker (bulk bar and drawers).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Select, Typography } from 'antd';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { useOwners } from '@/lib/hooks';
import { useTags } from './Tags';

/** 适用对象 / module */
export type MacroEntity = 'LEAD' | 'DEAL';
/** 动作类型 / action types */
export const MACRO_ACTION_TYPES = ['UPDATE_FIELD', 'ASSIGN_OWNER', 'ADD_TAG', 'REMOVE_TAG', 'CREATE_TASK'] as const;
/** 动作 / action */
export interface MacroAction {
  type: (typeof MACRO_ACTION_TYPES)[number];
  field?: string;
  value?: string;
  userId?: string;
  tagId?: string;
  subject?: string;
  dueInDays?: number;
  assignTo?: string;
}
/** 宏 / macro */
export interface Macro {
  id: string;
  name: string;
  description: string | null;
  entity: MacroEntity;
  scope: 'PERSONAL' | 'SHARED';
  actions: MacroAction[];
  createdById: string;
  createdBy: { id: string; name: string };
  runCount: number;
  lastRunAt: string | null;
  editable: boolean;
}
/** 执行结果 / run result */
interface RunResult {
  succeeded: string[];
  failed: { id: string; code: string; message: string }[];
}

/** 可修改的字段与取值（与服务端一致）/ updatable fields and values (same as the server) */
export const MACRO_UPDATE_FIELDS: Record<MacroEntity, Record<string, { enumPrefix: string; values: string[] }>> = {
  LEAD: {
    status: { enumPrefix: 'leadStatus', values: ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED'] },
    source: { enumPrefix: 'leadSource', values: ['WEBSITE', 'REFERRAL', 'EXHIBITION', 'COLD_CALL', 'ADVERTISEMENT', 'SOCIAL_MEDIA', 'OTHER'] },
  },
  DEAL: { stage: { enumPrefix: 'dealStage', values: ['QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'] } },
};

/**
 * 读取当前用户可用的宏。
 * Load the macros available to the user.
 */
export function useMacros(entity?: MacroEntity) {
  const [items, setItems] = useState<Macro[]>([]);
  const reload = useCallback(() => {
    api<{ items: Macro[] }>(`/api/macros${entity ? `?entity=${entity}` : ''}`)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, [entity]);
  useEffect(reload, [reload]);
  return { items, reload };
}

/**
 * 动作的文字说明（用户、标签按名称显示）。
 * Describe an action (users and tags by name).
 */
export function useActionText() {
  const owners = useOwners();
  const [tags] = useTags();
  const userName = (id?: string) => owners.find((u) => u.id === id)?.name ?? t('workflows.unknownUser');
  const tagName = (id?: string) => tags.find((x) => x.id === id)?.name ?? t('workflows.deletedTag');
  return (entity: MacroEntity, a: MacroAction): string => {
    switch (a.type) {
      case 'UPDATE_FIELD':
        return t('workflows.actionText.UPDATE_FIELD', { field: t(`workflows.field.${a.field}` as MessageKey), value: tEnum(MACRO_UPDATE_FIELDS[entity][a.field ?? '']?.enumPrefix ?? '', a.value) });
      case 'ASSIGN_OWNER':
        return t('workflows.actionText.ASSIGN_OWNER', { user: userName(a.userId) });
      case 'ADD_TAG':
        return t('workflows.actionText.ADD_TAG', { tag: tagName(a.tagId) });
      case 'REMOVE_TAG':
        return t('workflows.actionText.REMOVE_TAG', { tag: tagName(a.tagId) });
      case 'CREATE_TASK':
        return t('workflows.actionText.CREATE_TASK', { subject: a.subject ?? '', days: a.dueInDays ?? 0, user: a.assignTo === 'OWNER' ? t('workflows.recordOwner') : userName(a.assignTo) });
    }
  };
}

/** 服务端错误代码 → 提示 / server error codes → messages */
const RUN_ERRORS: Record<string, MessageKey> = { 'owner.assign required': 'macros.ownerAssign', user_not_found: 'macros.refMissing', tag_not_found: 'macros.refMissing' };

/**
 * “运行宏”下拉：选择后确认（列出将执行的动作），执行后显示结果；有失败时逐条列出原因。
 * "Run macro" picker: confirm (listing the steps), run, then show the result with per-record failures.
 * @param names ID → 显示名称（失败明细用）/ id → display name for failures
 */
export function MacroRunner({ entity, ids, names, onDone }: { entity: MacroEntity; ids: string[]; names: Record<string, string>; onDone: () => void }) {
  const { message, modal } = App.useApp();
  const { items } = useMacros(entity);
  const describe = useActionText();

  const run = async (m: Macro) => {
    try {
      const res = await api<RunResult>(`/api/macros/${m.id}/run`, { method: 'POST', body: { ids } });
      if (!res.failed.length) {
        message.success(t('macros.done', { name: m.name, n: res.succeeded.length }));
      } else {
        modal.warning({
          title: t('bulk.partial', { ok: res.succeeded.length, fail: res.failed.length }),
          content: (
            <div data-testid="macro-failures">
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
      const code = err instanceof ClientApiError ? err.details?.actions?.[0] : undefined;
      message.error(code && RUN_ERRORS[code] ? t(RUN_ERRORS[code]) : (err as Error).message);
    } finally {
      onDone();
    }
  };

  return (
    <Select
      aria-label={t('macros.run')}
      placeholder={t('macros.run')}
      style={{ width: 170 }}
      value={null}
      data-testid="macro-run"
      notFoundContent={t('macros.noMacros')}
      options={items.map((m) => ({ value: m.id, label: m.name }))}
      onChange={(id: string) => {
        const m = items.find((x) => x.id === id);
        if (!m) return;
        modal.confirm({
          title: t('macros.confirmRun', { name: m.name, n: ids.length }),
          content: t('macros.runSteps', { list: m.actions.map((a) => describe(entity, a)).join(t('common.listSep')) }),
          okText: t('macros.run'),
          cancelText: t('common.cancel'),
          onOk: () => run(m),
        });
      }}
    />
  );
}
