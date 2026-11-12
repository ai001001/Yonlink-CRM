/**
 * 报价单列表页：按状态筛选、搜索（报价单号、主题、商机、客户），查看详情与状态流转。报价单在商机详情中生成。
 * Quotes page: filter by status, search (number, subject, deal, account), open details and change status.
 * Quotes are generated from the deal detail.
 */
'use client';

import { useCallback, useState } from 'react';
import { Button, Card, Input, Segmented, Space, Table, Typography } from 'antd';
import { QuoteDrawer, QuoteStatusTag } from '@/components/QuoteDrawer';
import { t, tEnum } from '@/i18n';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { useOpenFromUrl, usePagedList } from '@/lib/hooks';
import type { Quote } from '@/lib/types';

const STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'] as const;
type StatusFilter = (typeof STATUSES)[number] | 'all';

export default function QuotesPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const { data, loading, reload, pagination } = usePagedList<Quote>('/api/quotes', { q, status: status === 'all' ? undefined : status });
  const [openId, setOpenId] = useState<string | null>(null);
  useOpenFromUrl(useCallback((id: string) => setOpenId(id), []));
  const close = useCallback(() => setOpenId(null), []);

  return (
    <Card title={t('quotes.title')}>
      <Typography.Paragraph type="secondary">{t('quotes.listHint')}</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented<StatusFilter>
          value={status}
          onChange={setStatus}
          options={[{ value: 'all', label: t('common.all') }, ...STATUSES.map((s) => ({ value: s, label: tEnum('quoteStatus', s) }))]}
        />
        <Input.Search allowClear placeholder={t('quotes.searchPlaceholder')} style={{ width: 280 }} onSearch={setQ} />
      </Space>
      <Table<Quote>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('quotes.number'),
            render: (_, r) => (
              <Button type="link" style={{ padding: 0 }} onClick={() => setOpenId(r.id)}>
                {r.quoteNumber}
              </Button>
            ),
          },
          { title: t('quotes.subject'), dataIndex: 'subject' },
          { title: t('quotes.account'), render: (_, r) => r.deal.account.name },
          { title: t('quotes.deal'), render: (_, r) => r.deal.name },
          { title: t('quotes.status'), render: (_, r) => <QuoteStatusTag quote={r} /> },
          { title: t('quotes.total'), align: 'right', render: (_, r) => fmtMoney(r.total, r.currency) },
          { title: t('quotes.validUntil'), render: (_, r) => fmtDate(r.validUntil?.slice(0, 10)) },
          { title: t('quotes.createdBy'), render: (_, r) => r.createdBy?.name },
          { title: t('common.createdAt'), render: (_, r) => fmtDateTime(r.createdAt) },
        ]}
      />
      <QuoteDrawer quoteId={openId} onClose={close} onChanged={() => void reload()} />
    </Card>
  );
}
