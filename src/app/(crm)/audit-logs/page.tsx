/**
 * 审计日志页：按对象类型、操作、操作人、时间筛选（只读）。
 * Audit log page: filter by entity type, action, actor and time (read-only).
 */
'use client';

import { useMemo, useState } from 'react';
import { Alert, Card, DatePicker, Select, Space, Table, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { actionLabel, AuditChanges, type AuditLogEntry } from '@/components/AuditChanges';
import { t, tEnum } from '@/i18n';
import { fmtDateTime } from '@/lib/format';
import { useOwners, usePagedList } from '@/lib/hooks';

const ENTITIES = ['lead', 'account', 'contact', 'deal', 'activity', 'note', 'product', 'quote', 'order', 'invoice', 'tag', 'view', 'attachment', 'target', 'user', 'auth'];
const ACTIONS: Record<string, string[]> = {
  lead: ['create', 'update', 'delete', 'restore', 'purge', 'expire', 'merge', 'convert', 'tags', 'import', 'export'],
  account: ['create', 'update', 'delete', 'restore', 'purge', 'expire', 'merge', 'tags', 'import', 'export'],
  contact: ['create', 'update', 'delete'],
  deal: ['create', 'update', 'delete', 'restore', 'purge', 'expire', 'tags', 'export', 'add_item', 'update_item', 'remove_item'],
  activity: ['create', 'update', 'delete', 'export'],
  note: ['create', 'update', 'delete'],
  product: ['create', 'update', 'delete'],
  quote: ['create', 'update', 'sync_items', 'status', 'delete'],
  order: ['create', 'update', 'status'],
  invoice: ['create', 'update', 'payment', 'payment_delete', 'void'],
  tag: ['create', 'update', 'delete'],
  view: ['create', 'update', 'delete'],
  attachment: ['create', 'delete'],
  target: ['update'],
  user: ['create', 'update', 'reset_password'],
  auth: ['login', 'demo_login', 'login_failed', 'logout'],
};

export default function AuditLogsPage() {
  const owners = useOwners();
  const users = useMemo(() => new Map(owners.map((u) => [u.id, u.name])), [owners]);
  const [entityType, setEntityType] = useState<string>();
  const [action, setAction] = useState<string>();
  const [actorId, setActorId] = useState<string>();
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const { data, loading, pagination } = usePagedList<AuditLogEntry>('/api/audit-logs', {
    entityType,
    action,
    actorId,
    from: range?.[0]?.startOf('day').toISOString(),
    to: range?.[1]?.add(1, 'day').startOf('day').toISOString(),
  });

  const actionOptions = (entityType ? [entityType] : ENTITIES).flatMap((e) =>
    (ACTIONS[e] ?? []).map((v) => ({ value: `${e}.${v}`, label: actionLabel(`${e}.${v}`) })),
  );

  return (
    <Card title={t('audit.title')}>
      <Alert type="info" showIcon title={t('audit.appendOnly')} style={{ marginBottom: 16 }} />
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          allowClear
          placeholder={t('audit.entity')}
          style={{ width: 120 }}
          // 选项固定且较少，关闭虚拟滚动，全部选项始终渲染 / few fixed options: no virtual list, all options always rendered
          virtual={false}
          listHeight={360}
          value={entityType}
          onChange={(v) => {
            setEntityType(v);
            setAction(undefined);
          }}
          options={ENTITIES.map((v) => ({ value: v, label: tEnum('auditEntity', v) }))}
        />
        <Select allowClear placeholder={t('audit.action')} style={{ width: 160 }} value={action} onChange={setAction} options={actionOptions} />
        <Select allowClear placeholder={t('audit.actor')} style={{ width: 140 }} value={actorId} onChange={setActorId} options={owners.map((u) => ({ value: u.id, label: u.name }))} />
        <DatePicker.RangePicker value={range} onChange={(v) => setRange(v)} placeholder={[t('audit.dateRange'), t('audit.dateRange')]} />
      </Space>
      <Table<AuditLogEntry>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        columns={[
          { title: t('audit.time'), dataIndex: 'createdAt', width: 150, render: fmtDateTime },
          { title: t('audit.actor'), width: 110, render: (_, r) => r.actor?.name ?? t('audit.system') },
          { title: t('audit.action'), dataIndex: 'action', width: 130, render: actionLabel },
          {
            title: t('audit.entity'),
            width: 110,
            render: (_, r) => <Typography.Text type="secondary">{r.entityId?.slice(0, 8)}</Typography.Text>,
          },
          { title: t('audit.changes'), render: (_, r) => <AuditChanges entry={r} users={users} /> },
          { title: t('audit.ip'), dataIndex: 'ip', width: 120 },
        ]}
      />
    </Card>
  );
}
