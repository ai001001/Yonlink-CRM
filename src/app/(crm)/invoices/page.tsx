/**
 * 发票列表页：按状态（含逾期）筛选、搜索（发票号、主题、订单号、商机、客户），查看详情、收款与作废。发票由销售订单生成。
 * Invoices page: filter by status (incl. overdue), search (number, subject, order number, deal, account), open
 * details, record payments and void. Invoices are generated from sales orders.
 */
'use client';

import { useCallback, useState } from 'react';
import { Button, Card, Input, Segmented, Space, Table, Typography } from 'antd';
import { balanceOf, InvoiceDrawer, InvoiceStatusTag } from '@/components/InvoiceDrawer';
import { t, tEnum } from '@/i18n';
import { fmtDate, fmtMoney } from '@/lib/format';
import { useOpenFromUrl, usePagedList } from '@/lib/hooks';
import type { Invoice } from '@/lib/types';

const STATUSES = ['UNPAID', 'PARTIALLY_PAID', 'PAID', 'VOID'] as const;
type StatusFilter = (typeof STATUSES)[number] | 'OVERDUE' | 'all';

export default function InvoicesPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const { data, loading, reload, pagination } = usePagedList<Invoice>('/api/invoices', { q, status: status === 'all' ? undefined : status });
  const [openId, setOpenId] = useState<string | null>(null);
  useOpenFromUrl(useCallback((id: string) => setOpenId(id), []));
  const close = useCallback(() => setOpenId(null), []);

  return (
    <Card title={t('invoices.title')}>
      <Typography.Paragraph type="secondary">{t('invoices.listHint')}</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented<StatusFilter>
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: t('common.all') },
            ...STATUSES.map((s) => ({ value: s, label: tEnum('invoiceStatus', s) })),
            { value: 'OVERDUE', label: t('invoices.overdue') },
          ]}
        />
        <Input.Search allowClear placeholder={t('invoices.searchPlaceholder')} style={{ width: 280 }} onSearch={setQ} />
      </Space>
      <Table<Invoice>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('invoices.number'),
            render: (_, r) => (
              <Button type="link" style={{ padding: 0 }} onClick={() => setOpenId(r.id)}>
                {r.invoiceNumber}
              </Button>
            ),
          },
          { title: t('invoices.subject'), dataIndex: 'subject' },
          { title: t('quotes.account'), render: (_, r) => r.deal.account.name },
          { title: t('invoices.order'), render: (_, r) => r.salesOrder.orderNumber },
          { title: t('invoices.status'), render: (_, r) => <InvoiceStatusTag invoice={r} /> },
          { title: t('invoices.total'), align: 'right', render: (_, r) => fmtMoney(r.total, r.currency) },
          { title: t('invoices.balance'), align: 'right', render: (_, r) => (r.status === 'VOID' ? '—' : fmtMoney(balanceOf(r), r.currency)) },
          { title: t('invoices.invoiceDate'), render: (_, r) => fmtDate(r.invoiceDate.slice(0, 10)) },
          { title: t('invoices.dueDate'), render: (_, r) => fmtDate(r.dueDate.slice(0, 10)) },
        ]}
      />
      <InvoiceDrawer invoiceId={openId} onClose={close} onChanged={() => void reload()} />
    </Card>
  );
}
