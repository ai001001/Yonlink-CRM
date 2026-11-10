/**
 * 审计变更内容展示：字段名、枚举值翻译，脱敏值原样显示。
 * Render audit change sets: translated field names and enum values; redacted values shown as-is.
 */
'use client';

import { Space, Typography } from 'antd';
import { t, tEnum, type MessageKey } from '@/i18n';

/** 审计日志条目 / Audit log entry */
export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  changes: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
  actor: { id: string; name: string } | null;
}

// 字段 → 文案 key / field → message key
const FIELD_LABELS: Record<string, MessageKey> = {
  name: 'leads.name',
  company: 'leads.company',
  title: 'leads.jobTitle',
  phone: 'leads.phone',
  mobile: 'leads.mobile',
  email: 'leads.email',
  source: 'leads.source',
  status: 'leads.status',
  description: 'common.description',
  ownerId: 'common.owner',
  industry: 'accounts.industry',
  website: 'accounts.website',
  address: 'accounts.address',
  isPrimary: 'contacts.isPrimary',
  accountId: 'deals.account',
  amount: 'deals.amount',
  currency: 'deals.currency',
  stage: 'deals.stage',
  expectedCloseDate: 'deals.expectedCloseDate',
  type: 'activities.type',
  subject: 'activities.subject',
  content: 'activities.content',
  dueAt: 'activities.dueAt',
  completed: 'activities.completed',
  leadId: 'activities.lead',
  dealId: 'activities.deal',
};

// 枚举字段 → 翻译前缀 / enum field → translation prefix
const ENUM_PREFIX: Record<string, string> = {
  status: 'leadStatus',
  source: 'leadSource',
  industry: 'industry',
  stage: 'dealStage',
  type: 'activityType',
};

/**
 * 操作名称，如“线索 · 修改”。
 * Action label, e.g. “Lead · Update”.
 */
export function actionLabel(action: string): string {
  const [entity = '', verb = ''] = action.split('.');
  return `${tEnum('auditEntity', entity)} · ${tEnum('auditAction', verb)}`;
}

/**
 * 字段名称。
 * Field label.
 */
const fieldLabel = (field: string, entityType: string): string => {
  if (entityType === 'contact' && field === 'name') return t('contacts.name');
  if (entityType === 'account' && field === 'name') return t('accounts.name');
  if (entityType === 'deal' && field === 'name') return t('deals.name');
  if (entityType === 'account' && field === 'phone') return t('accounts.phone');
  const key = FIELD_LABELS[field];
  return key ? t(key) : field;
};

/**
 * 单个值的显示。
 * Display a single value.
 */
function value(field: string, v: unknown, users: Map<string, string>): string {
  if (v === null || v === undefined || v === '') return '—';
  if (v === '[redacted]') return t('audit.redacted');
  if (typeof v === 'boolean') return v ? t('common.yes') : t('common.no');
  if (field === 'ownerId') return users.get(String(v)) ?? String(v).slice(0, 8);
  if (field.endsWith('Id')) return String(v).slice(0, 8);
  if (ENUM_PREFIX[field]) return tEnum(ENUM_PREFIX[field]!, String(v));
  if (field === 'expectedCloseDate') return String(v).slice(0, 10);
  if (field === 'dueAt') return String(v).replace('T', ' ').slice(0, 16);
  return String(v);
}

export function AuditChanges({ entry, users }: { entry: AuditLogEntry; users: Map<string, string> }) {
  const c = entry.changes ?? {};
  const lines: string[] = [];
  const fields = c.fields as Record<string, [unknown, unknown]> | undefined;
  const snap = (c.after ?? c.before) as Record<string, unknown> | undefined;
  if (fields) {
    for (const [f, [b, a]] of Object.entries(fields)) lines.push(`${fieldLabel(f, entry.entityType)}：${value(f, b, users)} → ${value(f, a, users)}`);
  } else if (snap) {
    for (const [f, v] of Object.entries(snap)) if (v !== null) lines.push(`${fieldLabel(f, entry.entityType)}：${value(f, v, users)}`);
  } else if (typeof c.reason === 'string') {
    lines.push(tEnum('auditReason', c.reason));
  } else if (entry.action === 'lead.convert') {
    lines.push(`${t('nav.accounts')}：${value('accountId', c.accountId, users)}`);
    if (c.dealId) lines.push(`${t('nav.deals')}：${value('dealId', c.dealId, users)}`);
  }
  if (typeof c.via === 'string') lines.push(t('audit.via', { via: actionLabel(c.via) }));
  if (!lines.length) return null;
  return (
    <Space orientation="vertical" size={0}>
      {lines.map((l, i) => (
        <Typography.Text key={i} style={{ fontSize: 12 }}>
          {l}
        </Typography.Text>
      ))}
    </Space>
  );
}
