/**
 * 销售目标与预测页：按月或季度、币种查看每位负责人的目标、已赢单、完成率、在手商机、加权预测与最好情况；
 * 管理员与经理可在月视图中直接设定目标（清空即清除）。
 * Sales targets and forecast: per-owner target, won, attainment, pipeline, weighted forecast and best case by month or
 * quarter and currency; admins and managers edit targets inline in the month view (empty clears).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Card, Col, DatePicker, InputNumber, Progress, Row, Segmented, Select, Space, Statistic, Table, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { usePermissions } from '@/components/AuthProvider';
import { t, tEnum } from '@/i18n';
import { api, qs } from '@/lib/api';
import { fmtMoney } from '@/lib/format';

const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY'];
type Kind = 'month' | 'quarter';

/** 一行预测 / forecast row */
interface ForecastRow {
  ownerId: string | null;
  name: string | null;
  target: string | null;
  won: string;
  wonCount: number;
  gap: string | null;
  attainment: number | null;
  open: string;
  openCount: number;
  weighted: string;
  forecast: string;
  forecastAttainment: number | null;
  bestCase: string;
}

/** 预测数据 / forecast payload */
interface Forecast {
  period: string;
  kind: Kind;
  months: string[];
  currency: string;
  probabilities: Record<string, number>;
  canEdit: boolean;
  rows: ForecastRow[];
  totals: ForecastRow;
}

/** 期间参数 / period parameter */
const periodOf = (kind: Kind, d: Dayjs) => (kind === 'month' ? d.format('YYYY-MM') : `${d.year()}-Q${Math.floor(d.month() / 3) + 1}`);

/** 完成率进度条 / attainment bar */
function Attainment({ value }: { value: number | null }) {
  if (value === null) return <Typography.Text type="secondary">—</Typography.Text>;
  return <Progress percent={Math.min(100, value)} format={() => `${value}%`} size="small" status={value >= 100 ? 'success' : 'normal'} style={{ minWidth: 120 }} />;
}

/**
 * 目标单元格：失焦或回车时保存，清空即清除。
 * Target cell: saves on blur or Enter; empty clears the target.
 */
function TargetCell({ row, month, currency, onSaved }: { row: ForecastRow; month: string; currency: string; onSaved: () => void }) {
  const { message } = App.useApp();
  const [value, setValue] = useState<string | null>(row.target);
  const save = async () => {
    const next = value === '' || value === null ? null : value;
    if ((next === null ? null : Number(next).toFixed(2)) === row.target) return;
    try {
      await api('/api/forecasts/targets', { method: 'PUT', body: { userId: row.ownerId, month, currency, amount: next } });
      message.success(next === null ? t('forecasts.targetCleared') : t('forecasts.targetSaved'));
      onSaved();
    } catch (err) {
      message.error((err as Error).message);
    }
  };
  return (
    <InputNumber<string>
      stringMode
      min="0"
      precision={2}
      style={{ width: 150 }}
      aria-label={t('forecasts.editTarget', { name: row.name ?? '' })}
      placeholder={t('forecasts.targetPlaceholder')}
      value={value}
      onChange={setValue}
      onBlur={() => void save()}
      onPressEnter={() => void save()}
    />
  );
}

export default function ForecastsPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const [kind, setKind] = useState<Kind>('month');
  const [date, setDate] = useState<Dayjs>(() => dayjs());
  const [currency, setCurrency] = useState('CNY');
  const [data, setData] = useState<Forecast | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<Forecast>(`/api/forecasts${qs({ period: periodOf(kind, date), currency })}`));
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [kind, date, currency, message]);

  useEffect(() => {
    // 条件变化时加载 / load when the period or currency changes
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const m = (v: string | null) => (v === null ? '—' : fmtMoney(v, currency));
  const probs = data
    ? Object.entries(data.probabilities)
        .map(([stage, p]) => `${tEnum('dealStage', stage)} ${p}%`)
        .join(t('common.listSep'))
    : '';
  const totals = data?.totals;
  const gapText = (r: ForecastRow) => {
    if (r.gap === null) return '—';
    return Number(r.gap) < 0 ? t('forecasts.exceeded', { amount: m(String(-Number(r.gap))) }) : m(r.gap);
  };

  return (
    <Card title={t('forecasts.title')}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented<Kind>
          value={kind}
          onChange={setKind}
          options={[
            { value: 'month', label: t('forecasts.month') },
            { value: 'quarter', label: t('forecasts.quarter') },
          ]}
        />
        <DatePicker aria-label={t('forecasts.period')} picker={kind} allowClear={false} value={date} onChange={(d) => d && setDate(d)} />
        <Select aria-label={t('forecasts.currency')} style={{ width: 100 }} value={currency} onChange={setCurrency} options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
      </Space>
      <Alert type="info" showIcon title={`${t('forecasts.hint', { probs })}${perm.can('record.read.all') ? '' : t('forecasts.salesScope')}`} style={{ marginBottom: 12 }} />
      {data?.kind === 'quarter' && perm.can('forecast.manage') && <Alert type="warning" showIcon title={t('forecasts.quarterHint')} style={{ marginBottom: 12 }} />}
      {totals && (
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }} data-testid="forecast-kpis">
          <Col xs={24} sm={12} xl={6}>
            <Card size="small" data-testid="kpi-target">
              <Statistic title={t('forecasts.target')} value={totals.target === null ? t('forecasts.noTarget') : m(totals.target)} />
            </Card>
          </Col>
          <Col xs={24} sm={12} xl={6}>
            <Card size="small" data-testid="kpi-won">
              <Statistic title={t('forecasts.won')} value={m(totals.won)} />
              <Attainment value={totals.attainment} />
            </Card>
          </Col>
          <Col xs={24} sm={12} xl={6}>
            <Card size="small" data-testid="kpi-forecast">
              <Statistic title={t('forecasts.forecast')} value={m(totals.forecast)} />
              <Attainment value={totals.forecastAttainment} />
            </Card>
          </Col>
          <Col xs={24} sm={12} xl={6}>
            <Card size="small" data-testid="kpi-best">
              <Statistic title={t('forecasts.bestCase')} value={m(totals.bestCase)} />
            </Card>
          </Col>
        </Row>
      )}
      <Table<ForecastRow>
        data-testid="forecast-table"
        rowKey={(r) => r.ownerId ?? 'none'}
        loading={loading}
        dataSource={data?.rows ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('common.empty') }}
        columns={[
          { title: t('forecasts.owner'), render: (_, r) => r.name ?? t('forecasts.unassigned') },
          {
            title: t('forecasts.target'),
            align: 'right',
            render: (_, r) =>
              data?.canEdit && r.ownerId ? (
                <TargetCell key={`${r.ownerId}-${data.period}-${currency}-${r.target}`} row={r} month={data.period} currency={currency} onSaved={() => void load()} />
              ) : r.ownerId ? (
                r.target === null ? <Typography.Text type="secondary">{t('forecasts.noTarget')}</Typography.Text> : m(r.target)
              ) : (
                '—'
              ),
          },
          { title: t('forecasts.won'), align: 'right', render: (_, r) => <span>{m(r.won)} <Typography.Text type="secondary">{t('forecasts.deals', { n: r.wonCount })}</Typography.Text></span> },
          { title: t('forecasts.attainment'), render: (_, r) => <Attainment value={r.attainment} /> },
          { title: t('forecasts.gap'), align: 'right', render: (_, r) => gapText(r) },
          { title: t('forecasts.open'), align: 'right', render: (_, r) => <span>{m(r.open)} <Typography.Text type="secondary">{t('forecasts.deals', { n: r.openCount })}</Typography.Text></span> },
          { title: t('forecasts.weighted'), align: 'right', render: (_, r) => m(r.weighted) },
          { title: t('forecasts.forecast'), align: 'right', render: (_, r) => m(r.forecast) },
          { title: t('forecasts.forecastAttainment'), render: (_, r) => <Attainment value={r.forecastAttainment} /> },
          { title: t('forecasts.bestCase'), align: 'right', render: (_, r) => m(r.bestCase) },
        ]}
        summary={() =>
          totals ? (
            <Table.Summary.Row data-testid="forecast-total">
              <Table.Summary.Cell index={0}>
                <Typography.Text strong>{t('forecasts.total')}</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">{m(totals.target)}</Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right">{m(totals.won)}</Table.Summary.Cell>
              <Table.Summary.Cell index={3}>
                <Attainment value={totals.attainment} />
              </Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right">{gapText(totals)}</Table.Summary.Cell>
              <Table.Summary.Cell index={5} align="right">{m(totals.open)}</Table.Summary.Cell>
              <Table.Summary.Cell index={6} align="right">{m(totals.weighted)}</Table.Summary.Cell>
              <Table.Summary.Cell index={7} align="right">{m(totals.forecast)}</Table.Summary.Cell>
              <Table.Summary.Cell index={8}>
                <Attainment value={totals.forecastAttainment} />
              </Table.Summary.Cell>
              <Table.Summary.Cell index={9} align="right">{m(totals.bestCase)}</Table.Summary.Cell>
            </Table.Summary.Row>
          ) : null
        }
      />
    </Card>
  );
}
