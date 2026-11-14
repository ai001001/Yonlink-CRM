/**
 * 销售报表页：按币种、时间段、负责人查看漏斗、按月赢单、负责人排行、线索来源转化与报价单状态。
 * Sales reports page: funnel, monthly wins, owner ranking, lead-source conversion and quote statuses by
 * currency, period and owner.
 */
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, App, Card, Col, DatePicker, Row, Select, Space, Spin, Statistic, Table, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { usePermissions } from '@/components/AuthProvider';
import { ColumnChart, HBarChart } from '@/components/Charts';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError, qs } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import { useOwners } from '@/lib/hooks';

const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY'];

/** 报表数据 / Report payload */
interface Report {
  currency: string;
  from: string;
  to: string;
  currencies: string[];
  summary: {
    openCount: number;
    openAmount: string;
    wonCount: number;
    wonAmount: string;
    lostCount: number;
    lostAmount: string;
    winRate: number | null;
    leadTotal: number;
    leadConverted: number;
    leadConversionRate: number | null;
    quoteAcceptanceRate: number | null;
  };
  funnel: { stage: string; count: number; amount: string }[];
  monthly: { month: string; wonCount: number; wonAmount: string; lostCount: number }[];
  owners: { ownerId: string | null; name: string | null; openCount: number; openAmount: string; wonCount: number; wonAmount: string; lostCount: number; winRate: number | null; activities: number }[];
  leadSources: { source: string | null; total: number; converted: number; conversionRate: number | null }[];
  quotes: { status: string; count: number; amount: string }[];
}

/** 百分比显示 / percentage display */
const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

/** 预设时间段 / period presets */
const presets: { label: string; value: [Dayjs, Dayjs] }[] = [
  { label: t('reports.thisMonth'), value: [dayjs().startOf('month'), dayjs()] },
  { label: t('reports.thisQuarter'), value: [dayjs().month(Math.floor(dayjs().month() / 3) * 3).startOf('month'), dayjs()] },
  { label: t('reports.thisYear'), value: [dayjs().startOf('year'), dayjs()] },
  { label: t('reports.last12Months'), value: [dayjs().subtract(11, 'month').startOf('month'), dayjs()] },
];

export default function ReportsPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canPickOwner = perm.can('record.read.all');
  const owners = useOwners();
  const [currency, setCurrency] = useState('CNY');
  const [range, setRange] = useState<[Dayjs, Dayjs]>(presets[3]!.value);
  const [ownerId, setOwnerId] = useState<string>();
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    // 筛选变化时重新加载 / reload when filters change
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    api<Report>(`/api/reports/sales${qs({ currency, from: range[0].format('YYYY-MM-DD'), to: range[1].format('YYYY-MM-DD'), ownerId })}`)
      .then((r) => alive && setData(r))
      .catch((err: unknown) => {
        const code = err instanceof ClientApiError ? (err.details?.from?.[0] ?? err.details?.to?.[0]) : undefined;
        message.error(code ? t(`reports.error.${code}` as MessageKey) : (err as Error).message);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [currency, range, ownerId, message]);

  const m = (v: string) => fmtMoney(v, currency);
  const currencyOptions = [...new Set([...(data?.currencies ?? []), currency, ...CURRENCIES])].map((c) => ({ value: c, label: c }));

  return (
    <Card title={t('reports.title')} extra={<Link href="/reports/receivables">{t('receivables.title')}</Link>}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select aria-label={t('reports.currency')} style={{ width: 100 }} value={currency} onChange={setCurrency} options={currencyOptions} />
        <DatePicker.RangePicker
          aria-label={t('reports.period')}
          allowClear={false}
          presets={presets}
          value={range}
          onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])}
        />
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
      <Alert type="info" showIcon title={`${t('reports.definitions')}${canPickOwner ? '' : t('reports.salesScope')}`} style={{ marginBottom: 16 }} />
      <Spin spinning={loading}>
        {data && (
          <div data-testid="reports">
            <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
              <Col xs={24} sm={12} lg={8} xl={4}>
                <Card size="small" data-testid="kpi-open">
                  <Statistic title={t('reports.openAmount')} value={m(data.summary.openAmount)} />
                  <Typography.Text type="secondary">{t('reports.openCount', { count: data.summary.openCount })}</Typography.Text>
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={8} xl={5}>
                <Card size="small" data-testid="kpi-won">
                  <Statistic title={t('reports.wonAmount')} value={m(data.summary.wonAmount)} />
                  <Typography.Text type="secondary">{t('reports.wonLost', { won: data.summary.wonCount, lost: data.summary.lostCount })}</Typography.Text>
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={8} xl={5}>
                <Card size="small" data-testid="kpi-win-rate">
                  <Statistic title={t('reports.winRate')} value={pct(data.summary.winRate)} />
                  <Typography.Text type="secondary">{t('reports.wonLost', { won: data.summary.wonCount, lost: data.summary.lostCount })}</Typography.Text>
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={12} xl={5}>
                <Card size="small" data-testid="kpi-lead-conversion">
                  <Statistic title={t('reports.leadConversion')} value={pct(data.summary.leadConversionRate)} />
                  <Typography.Text type="secondary">{t('reports.leadConverted', { converted: data.summary.leadConverted, total: data.summary.leadTotal })}</Typography.Text>
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={12} xl={5}>
                <Card size="small" data-testid="kpi-quote-acceptance">
                  <Statistic title={t('reports.quoteAcceptance')} value={pct(data.summary.quoteAcceptanceRate)} />
                  <Typography.Text type="secondary">{t('reports.quoteAcceptanceHint')}</Typography.Text>
                </Card>
              </Col>
            </Row>
            <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
              <Col xs={24} xl={10}>
                <Card size="small" title={t('reports.funnel')}>
                  <HBarChart
                    label={t('reports.funnel')}
                    testId="chart-funnel"
                    data={data.funnel.map((f) => ({ key: f.stage, label: tEnum('dealStage', f.stage), value: Number(f.amount), display: `${m(f.amount)} · ${t('reports.countUnit', { count: f.count })}` }))}
                  />
                </Card>
              </Col>
              <Col xs={24} xl={14}>
                <Card size="small" title={t('reports.monthly')} extra={<Typography.Text type="secondary">{t('reports.monthlyLegend')}</Typography.Text>}>
                  <ColumnChart
                    label={t('reports.monthly')}
                    testId="chart-monthly"
                    data={data.monthly.map((x) => ({
                      key: x.month,
                      label: x.month.slice(2).replace('-', '/'),
                      value: Number(x.wonAmount),
                      secondary: x.lostCount,
                      title: t('reports.monthlyTitle', { month: x.month, won: x.wonCount, amount: m(x.wonAmount), lost: x.lostCount }),
                    }))}
                  />
                </Card>
              </Col>
            </Row>
            <Card size="small" title={t('reports.owners')} style={{ marginBottom: 16 }}>
              <Table
                data-testid="table-owners"
                rowKey={(r) => r.ownerId ?? 'none'}
                size="small"
                pagination={false}
                scroll={{ x: 'max-content' }}
                dataSource={data.owners}
                locale={{ emptyText: t('common.empty') }}
                columns={[
                  { title: t('reports.owner'), render: (_, r) => r.name ?? t('reports.unassigned') },
                  { title: t('reports.col.openCount'), dataIndex: 'openCount', align: 'right' },
                  { title: t('reports.col.openAmount'), align: 'right', render: (_, r) => m(r.openAmount) },
                  { title: t('reports.col.wonCount'), dataIndex: 'wonCount', align: 'right' },
                  { title: t('reports.col.wonAmount'), align: 'right', render: (_, r) => m(r.wonAmount) },
                  { title: t('reports.col.lostCount'), dataIndex: 'lostCount', align: 'right' },
                  { title: t('reports.col.winRate'), align: 'right', render: (_, r) => pct(r.winRate) },
                  { title: t('reports.col.activities'), dataIndex: 'activities', align: 'right' },
                ]}
              />
            </Card>
            <Row gutter={[16, 16]}>
              <Col xs={24} xl={14}>
                <Card size="small" title={t('reports.leadSources')}>
                  <HBarChart
                    label={t('reports.leadSources')}
                    testId="chart-lead-sources"
                    data={data.leadSources.map((s) => ({
                      key: s.source ?? 'none',
                      label: s.source ? tEnum('leadSource', s.source) : t('reports.noSource'),
                      value: s.total,
                      display: `${s.total} · ${t('reports.col.converted')} ${s.converted}${t('common.parens', { text: pct(s.conversionRate) })}`,
                    }))}
                  />
                </Card>
              </Col>
              <Col xs={24} xl={10}>
                <Card size="small" title={t('reports.quotes')}>
                  <Table
                    data-testid="table-quotes"
                    rowKey="status"
                    size="small"
                    pagination={false}
                    dataSource={data.quotes}
                    columns={[
                      { title: t('quotes.status'), render: (_, r) => tEnum('quoteStatus', r.status) },
                      { title: t('reports.col.count'), dataIndex: 'count', align: 'right' },
                      { title: t('reports.col.amount'), align: 'right', render: (_, r) => m(r.amount) },
                    ]}
                  />
                </Card>
              </Col>
            </Row>
          </div>
        )}
      </Spin>
    </Card>
  );
}
