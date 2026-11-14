/**
 * 销售订单列表页：按状态筛选、搜索（订单号、主题、报价单号、商机、客户），查看详情与状态流转。订单由已接受的报价单生成。
 * Sales orders page: filter by status, search (number, subject, quote number, deal, account), open details and
 * change status. Orders are generated from accepted quotes.
 */
'use client';

import { useCallback, useState } from 'react';
import { Button, Card, Input, Segmented, Space, Table, Typography } from 'antd';
import { OrderStatusTag, SalesOrderDrawer } from '@/components/SalesOrderDrawer';
import { t, tEnum } from '@/i18n';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { useOpenFromUrl, usePagedList } from '@/lib/hooks';
import type { SalesOrder } from '@/lib/types';

const STATUSES = ['CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;
type StatusFilter = (typeof STATUSES)[number] | 'all';

export default function SalesOrdersPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const { data, loading, reload, pagination } = usePagedList<SalesOrder>('/api/sales-orders', { q, status: status === 'all' ? undefined : status });
  const [openId, setOpenId] = useState<string | null>(null);
  useOpenFromUrl(useCallback((id: string) => setOpenId(id), []));
  const close = useCallback(() => setOpenId(null), []);

  return (
    <Card title={t('orders.title')}>
      <Typography.Paragraph type="secondary">{t('orders.listHint')}</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented<StatusFilter>
          value={status}
          onChange={setStatus}
          options={[{ value: 'all', label: t('common.all') }, ...STATUSES.map((s) => ({ value: s, label: tEnum('orderStatus', s) }))]}
        />
        <Input.Search allowClear placeholder={t('orders.searchPlaceholder')} style={{ width: 280 }} onSearch={setQ} />
      </Space>
      <Table<SalesOrder>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('orders.number'),
            render: (_, r) => (
              <Button type="link" style={{ padding: 0 }} onClick={() => setOpenId(r.id)}>
                {r.orderNumber}
              </Button>
            ),
          },
          { title: t('orders.subject'), dataIndex: 'subject' },
          { title: t('quotes.account'), render: (_, r) => r.deal.account.name },
          { title: t('orders.quote'), render: (_, r) => r.quote.quoteNumber },
          { title: t('orders.status'), render: (_, r) => <OrderStatusTag status={r.status} /> },
          { title: t('quotes.total'), align: 'right', render: (_, r) => fmtMoney(r.total, r.currency) },
          { title: t('orders.expectedDelivery'), render: (_, r) => fmtDate(r.expectedDelivery?.slice(0, 10)) },
          { title: t('quotes.createdBy'), render: (_, r) => r.createdBy?.name },
          { title: t('common.createdAt'), render: (_, r) => fmtDateTime(r.createdAt) },
        ]}
      />
      <SalesOrderDrawer orderId={openId} onClose={close} onChanged={() => void reload()} />
    </Card>
  );
}
