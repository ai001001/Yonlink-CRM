/**
 * 回收站页：查看已删除的线索、客户、商机，恢复或彻底删除（彻底删除与清空仅管理员）。
 * Recycle bin page: view deleted leads, accounts and deals; restore or permanently delete (purge and empty: admins).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, App, Button, Card, Input, Popconfirm, Segmented, Space, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { usePermissions } from '@/components/AuthProvider';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError, qs } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

type Entity = 'lead' | 'account' | 'deal';
type Filter = Entity | 'all';

/** 回收站条目 / Recycle-bin entry */
interface Item {
  id: string;
  entityType: Entity;
  entityId: string;
  displayName: string;
  summary: Record<string, number>;
  deletedAt: string;
  expiresAt: string;
  deletedBy: { id: string; name: string } | null;
}

const COLOR: Record<Entity, string> = { lead: 'gold', account: 'geekblue', deal: 'green' };
const PAGE: Record<Entity, string> = { lead: '/leads', account: '/accounts', deal: '/deals' };
const SUMMARY_KEYS = ['contacts', 'notes', 'activities', 'tags', 'attachments', 'lineItems', 'quotes'] as const;

export default function RecycleBinPage() {
  const { message, notification } = App.useApp();
  const perm = usePermissions();
  const canPurge = perm.can('recycle.purge');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: Item[]; retentionDays: number }>(`/api/recycle-bin${qs({ entityType: filter === 'all' ? undefined : filter, q })}`);
      setItems(r.items);
      setDays(r.retentionDays);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter, q, message]);

  useEffect(() => {
    // 筛选变化时加载 / load when filters change
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const restore = async (item: Item) => {
    try {
      const r = await api<{ entityType: Entity; entityId: string; skipped: string[] }>(`/api/recycle-bin/${item.id}/restore`, { method: 'POST' });
      notification.success({
        title: r.skipped.length
          ? t('recycle.restoredPartial', { items: r.skipped.map((s) => t(`recycle.skipped.${s}` as MessageKey)).join('、') })
          : `${t('recycle.restored')}：${item.displayName}`,
        description: <Link href={`${PAGE[r.entityType]}?id=${r.entityId}`}>{t('recycle.view')}</Link>,
      });
      void load();
    } catch (err) {
      const d = err instanceof ClientApiError ? err.details : undefined;
      const code = d?.account ? 'account_missing' : d?.products ? 'products_missing' : undefined;
      message.error(code ? t(`recycle.error.${code}` as MessageKey) : (err as Error).message);
    }
  };

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      message.success(ok);
      void load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <Card
      title={t('recycle.title')}
      extra={
        canPurge && (
          <Popconfirm title={t('recycle.confirmEmpty', { n: items.length })} disabled={!items.length} onConfirm={() => run(() => api('/api/recycle-bin', { method: 'DELETE' }), t('recycle.emptied', { n: items.length }))}>
            <Button danger disabled={!items.length}>
              {t('recycle.empty')}
            </Button>
          </Popconfirm>
        )
      }
    >
      <Alert type="info" showIcon title={t('recycle.hint', { days })} style={{ marginBottom: 16 }} />
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('common.all') },
            { value: 'lead', label: t('nav.leads') },
            { value: 'account', label: t('nav.accounts') },
            { value: 'deal', label: t('nav.deals') },
          ]}
        />
        <Input.Search allowClear placeholder={t('recycle.searchPlaceholder')} style={{ width: 240 }} onSearch={setQ} />
      </Space>
      <Table<Item>
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={{ pageSize: 20, showTotal: (total) => t('common.total', { total }) }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('common.empty') }}
        columns={[
          { title: t('recycle.type'), render: (_, r) => <Tag color={COLOR[r.entityType]}>{tEnum('auditEntity', r.entityType)}</Tag> },
          { title: t('recycle.name'), dataIndex: 'displayName' },
          {
            title: t('recycle.related'),
            render: (_, r) => (
              <Typography.Text type="secondary">
                {SUMMARY_KEYS.filter((k) => (r.summary[k] ?? 0) > 0)
                  .map((k) => t(`recycle.summary.${k}` as MessageKey, { n: r.summary[k]! }))
                  .join('、') || '—'}
              </Typography.Text>
            ),
          },
          { title: t('recycle.deletedBy'), render: (_, r) => r.deletedBy?.name ?? '—' },
          { title: t('recycle.deletedAt'), render: (_, r) => fmtDateTime(r.deletedAt) },
          { title: t('recycle.remaining'), render: (_, r) => t('recycle.days', { days: Math.max(0, Math.ceil(dayjs(r.expiresAt).diff(dayjs(), 'day', true))) }) },
          {
            title: t('common.actions'),
            render: (_, r) => (
              <Space>
                <Button type="link" size="small" onClick={() => void restore(r)}>
                  {t('recycle.restore')}
                </Button>
                {canPurge && (
                  <Popconfirm title={t('recycle.confirmPurge', { name: r.displayName })} onConfirm={() => run(() => api(`/api/recycle-bin/${r.id}`, { method: 'DELETE' }), t('common.deleted'))}>
                    <Button type="link" size="small" danger>
                      {t('recycle.purge')}
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}
