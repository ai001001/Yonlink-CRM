/**
 * 采购单列表页：按状态筛选、搜索（单号、主题、供应商、销售订单号），新建草稿、查看详情与处理（下单、收货、取消）。
 * 查看需 purchase.read，处理需 purchase.manage。
 * Purchase orders page: filter by status, search (number, subject, vendor, sales order number), create drafts, open
 * details and process them (order, receive, cancel). Viewing needs purchase.read, processing purchase.manage.
 */
'use client';

import { useCallback, useState } from 'react';
import { Button, Card, Input, Segmented, Space, Table, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { usePermissions } from '@/components/AuthProvider';
import { PoStatusTag, PurchaseOrderDrawer, PurchaseOrderForm, type PurchaseOrder } from '@/components/PurchaseOrderDrawer';
import { t, tEnum } from '@/i18n';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { useOpenFromUrl, usePagedList } from '@/lib/hooks';

const STATUSES = ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'] as const;

export default function PurchaseOrdersPage() {
  const perm = usePermissions();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>('all');
  const { data, loading, reload, pagination } = usePagedList<PurchaseOrder>('/api/purchase-orders', { q: q || undefined, status: status === 'all' ? undefined : status });
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useOpenFromUrl(useCallback((id: string) => setOpenId(id), []));

  return (
    <Card
      title={t('purchase.title')}
      extra={
        perm.can('purchase.manage') && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            {t('purchase.new')}
          </Button>
        )
      }
    >
      <Typography.Paragraph type="secondary">{t('purchase.listHint')}</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented value={status} onChange={(v) => setStatus(String(v))} options={[{ value: 'all', label: t('common.all') }, ...STATUSES.map((s) => ({ value: s, label: tEnum('poStatus', s) }))]} />
        <Input.Search allowClear placeholder={t('purchase.searchPlaceholder')} style={{ width: 280 }} onSearch={setQ} />
      </Space>
      <Table<PurchaseOrder>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('purchase.number'),
            render: (_, r) => (
              <Button type="link" style={{ padding: 0 }} onClick={() => setOpenId(r.id)}>
                {r.poNumber}
              </Button>
            ),
          },
          { title: t('purchase.subject'), dataIndex: 'subject' },
          { title: t('purchase.vendor'), render: (_, r) => r.vendor.name },
          { title: t('purchase.salesOrder'), render: (_, r) => r.salesOrder?.orderNumber },
          { title: t('purchase.status'), render: (_, r) => <PoStatusTag status={r.status} /> },
          { title: t('purchase.total'), align: 'right', render: (_, r) => fmtMoney(r.total, r.currency) },
          { title: t('purchase.expectedDate'), render: (_, r) => fmtDate(r.expectedDate?.slice(0, 10)) },
          { title: t('purchase.createdBy'), render: (_, r) => r.createdBy?.name },
          { title: t('common.createdAt'), render: (_, r) => fmtDateTime(r.createdAt) },
        ]}
      />
      <PurchaseOrderDrawer orderId={openId} onClose={() => setOpenId(null)} onChanged={() => void reload()} />
      <PurchaseOrderForm
        editing={creating ? 'new' : null}
        onClose={() => setCreating(false)}
        onSaved={(po) => {
          setCreating(false);
          void reload();
          setOpenId(po.id);
        }}
      />
    </Card>
  );
}
