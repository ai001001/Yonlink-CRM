/**
 * 应收账款报表页：按币种、负责人查看未收金额、逾期金额、近 30 天收款、账龄分布、按客户汇总与未收发票明细。
 * Accounts receivable page: outstanding and overdue balances, recent collections, aging, per-account totals and
 * open invoices by currency and owner.
 */
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, App, Card, Col, Row, Select, Space, Spin, Statistic, Table, Tag, Typography } from 'antd';
import { usePermissions } from '@/components/AuthProvider';
import { HBarChart } from '@/components/Charts';
import { t, type MessageKey } from '@/i18n';
import { api, qs } from '@/lib/api';
import { fmtDate, fmtMoney } from '@/lib/format';
import { useOwners } from '@/lib/hooks';

const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY'];
const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
type Bucket = (typeof BUCKETS)[number];
/** 账龄颜色（越久越红）/ bucket colours (older is redder) */
const BUCKET_COLOR: Record<Bucket, string> = { current: 'green', d1_30: 'gold', d31_60: 'orange', d61_90: 'volcano', d90_plus: 'red' };

/** 报表数据 / Report payload */
interface Receivables {
  currency: string;
  asOf: string;
  currencies: string[];
  summary: { outstanding: string; outstandingCount: number; overdue: string; overdueCount: number; collected: string; collectedCount: number };
  buckets: { bucket: Bucket; count: number; amount: string }[];
  accounts: { accountId: string; name: string; count: number; outstanding: string; buckets: Record<Bucket, string>; oldestDueDate: string; maxDaysOverdue: number }[];
  invoices: {
    id: string;
    invoiceNumber: string;
    account: { id: string; name: string };
    owner: { id: string; name: string } | null;
    invoiceDate: string;
    dueDate: string;
    total: string;
    balance: string;
    daysOverdue: number;
    bucket: Bucket;
  }[];
  truncated: boolean;
}

const bucketLabel = (b: Bucket) => t(`receivables.bucket.${b}` as MessageKey);

export default function ReceivablesPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canPickOwner = perm.can('record.read.all');
  const owners = useOwners();
  const [currency, setCurrency] = useState('CNY');
  const [ownerId, setOwnerId] = useState<string>();
  const [data, setData] = useState<Receivables | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    // 筛选变化时重新加载 / reload when filters change
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    api<Receivables>(`/api/reports/receivables${qs({ currency, ownerId })}`)
      .then((r) => alive && setData(r))
      .catch((err: Error) => message.error(err.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [currency, ownerId, message]);

  const m = (v: string) => fmtMoney(v, currency);
  const currencyOptions = [...new Set([...(data?.currencies ?? []), currency, ...CURRENCIES])].map((c) => ({ value: c, label: c }));

  return (
    <Card title={t('receivables.title')} extra={<Link href="/reports">{t('reports.title')}</Link>}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select aria-label={t('reports.currency')} style={{ width: 100 }} value={currency} onChange={setCurrency} options={currencyOptions} />
        {canPickOwner && (
          <Select
            aria-label={t('reports.owner')}
            allowClear
            placeholder={t('reports.allOwners')}
            style={{ width: 160 }}
            value={ownerId}
            onChange={setOwnerId}
            options={owners.map((u) => ({ value: u.id, label: u.name }))}
          />
        )}
      </Space>
      <Alert
        type="info"
        showIcon
        title={`${t('receivables.definitions', { date: data?.asOf ?? '' })}${canPickOwner ? '' : t('reports.salesScope')}`}
        style={{ marginBottom: 16 }}
      />
      <Spin spinning={loading}>
        {data && (
          <div data-testid="receivables">
            <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
              <Col xs={24} md={8}>
                <Card size="small" data-testid="kpi-outstanding">
                  <Statistic title={t('receivables.outstanding')} value={m(data.summary.outstanding)} />
                  <Typography.Text type="secondary">{t('receivables.invoiceCount', { count: data.summary.outstandingCount })}</Typography.Text>
                </Card>
              </Col>
              <Col xs={24} md={8}>
                <Card size="small" data-testid="kpi-overdue">
                  <Statistic title={t('receivables.overdue')} value={m(data.summary.overdue)} styles={{ content: { color: Number(data.summary.overdue) > 0 ? '#cf1322' : undefined } }} />
                  <Typography.Text type="secondary">{t('receivables.invoiceCount', { count: data.summary.overdueCount })}</Typography.Text>
                </Card>
              </Col>
              <Col xs={24} md={8}>
                <Card size="small" data-testid="kpi-collected">
                  <Statistic title={t('receivables.collected')} value={m(data.summary.collected)} />
                  <Typography.Text type="secondary">{t('receivables.paymentCount', { count: data.summary.collectedCount })}</Typography.Text>
                </Card>
              </Col>
            </Row>
            <Card size="small" title={t('receivables.aging')} style={{ marginBottom: 16 }}>
              <HBarChart
                label={t('receivables.aging')}
                testId="chart-aging"
                data={data.buckets.map((b) => ({ key: b.bucket, label: bucketLabel(b.bucket), value: Number(b.amount), display: `${m(b.amount)} · ${t('receivables.invoiceCount', { count: b.count })}` }))}
              />
            </Card>
            <Card size="small" title={t('receivables.byAccount')} style={{ marginBottom: 16 }}>
              <Table
                rowKey="accountId"
                size="small"
                pagination={false}
                scroll={{ x: 'max-content' }}
                dataSource={data.accounts}
                data-testid="receivables-accounts"
                locale={{ emptyText: t('receivables.none') }}
                columns={[
                  { title: t('quotes.account'), dataIndex: 'name', fixed: 'left' },
                  { title: t('receivables.invoices'), dataIndex: 'count', align: 'right' },
                  { title: t('receivables.outstanding'), dataIndex: 'outstanding', align: 'right', render: (v: string) => <Typography.Text strong>{m(v)}</Typography.Text> },
                  ...BUCKETS.map((b) => ({
                    title: bucketLabel(b),
                    key: b,
                    align: 'right' as const,
                    render: (_: unknown, r: Receivables['accounts'][number]) => (Number(r.buckets[b]) > 0 ? m(r.buckets[b]) : '—'),
                  })),
                  { title: t('receivables.oldestDue'), dataIndex: 'oldestDueDate', render: (v: string) => fmtDate(v) },
                ]}
              />
            </Card>
            <Card size="small" title={t('receivables.openInvoices')}>
              {data.truncated && <Alert type="warning" showIcon title={t('receivables.truncated', { n: data.invoices.length })} style={{ marginBottom: 12 }} />}
              <Table
                rowKey="id"
                size="small"
                pagination={{ pageSize: 20, hideOnSinglePage: true }}
                scroll={{ x: 'max-content' }}
                dataSource={data.invoices}
                data-testid="receivables-invoices"
                locale={{ emptyText: t('receivables.none') }}
                columns={[
                  { title: t('invoices.number'), render: (_, r) => <Link href={`/invoices?id=${r.id}`}>{r.invoiceNumber}</Link> },
                  { title: t('quotes.account'), render: (_, r) => r.account.name },
                  { title: t('reports.owner'), render: (_, r) => r.owner?.name },
                  { title: t('invoices.dueDate'), render: (_, r) => fmtDate(r.dueDate.slice(0, 10)) },
                  { title: t('invoices.total'), align: 'right', render: (_, r) => m(r.total) },
                  { title: t('invoices.balance'), align: 'right', render: (_, r) => m(r.balance) },
                  {
                    title: t('receivables.agingColumn'),
                    render: (_, r) => (
                      <Tag color={BUCKET_COLOR[r.bucket]}>{r.daysOverdue > 0 ? t('receivables.daysOverdue', { days: r.daysOverdue }) : bucketLabel('current')}</Tag>
                    ),
                  },
                ]}
              />
            </Card>
          </div>
        )}
      </Spin>
    </Card>
  );
}
