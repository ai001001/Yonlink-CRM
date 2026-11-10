/**
 * 工作台：数量统计、商机金额汇总、阶段分布、最近跟进、我的待办（全部来自数据库实时数据）。
 * Dashboard: counts, deal amounts, stage breakdown, recent activities, my to-dos (live database data).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { App, Card, Checkbox, Col, Empty, List, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import { BankOutlined, FundOutlined, UserAddOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useAuth } from '@/components/AuthProvider';
import { ACTIVITY_TYPE_COLOR, toggleActivity } from '@/components/RelatedActivities';
import { t, tEnum } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import type { Activity } from '@/lib/types';

interface Sum {
  currency: string;
  amount: string;
}

interface Dashboard {
  counts: { accounts: number; leads: number; deals: number };
  dealAmounts: { all: Sum[]; open: Sum[]; won: Sum[] };
  stages: { stage: string; currency: string; count: number; amount: string }[];
  recentActivities: Activity[];
  myTodos: Activity[];
  myTodoCount: number;
  myOverdueCount: number;
}

const STAGE_ORDER = ['QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'];

/**
 * 多币种金额显示（无数据时显示 ¥0.00）。
 * Multi-currency amount display (¥0.00 when empty).
 */
function Amounts({ sums, testId }: { sums: Sum[]; testId: string }) {
  if (!sums.length) return <span data-testid={testId}>{fmtMoney('0')}</span>;
  return (
    <Space orientation="vertical" size={0} data-testid={testId}>
      {sums.map((s) => (
        <span key={s.currency}>{fmtMoney(s.amount, s.currency)}</span>
      ))}
    </Space>
  );
}

/**
 * 关联对象简述。
 * Short description of related records.
 */
const related = (a: Activity) => [a.account?.name, a.lead?.name, a.deal?.name].filter(Boolean).join(' / ');

export default function DashboardPage() {
  const { me } = useAuth();
  const { message } = App.useApp();
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await api<Dashboard>('/api/dashboard'));
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const stageRows = [...(data?.stages ?? [])].sort(
    (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || a.currency.localeCompare(b.currency),
  );

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('dashboard.welcome', { name: me?.name ?? '' })}
      </Typography.Title>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <Card loading={loading}>
            <Link href="/accounts">
              <Statistic title={t('dashboard.accounts')} value={data?.counts.accounts ?? 0} prefix={<BankOutlined />} data-testid="kpi-accounts" />
            </Link>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card loading={loading}>
            <Link href="/leads">
              <Statistic title={t('dashboard.leads')} value={data?.counts.leads ?? 0} prefix={<UserAddOutlined />} data-testid="kpi-leads" />
            </Link>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card loading={loading}>
            <Link href="/deals">
              <Statistic title={t('dashboard.deals')} value={data?.counts.deals ?? 0} prefix={<FundOutlined />} data-testid="kpi-deals" />
            </Link>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card loading={loading} title={t('dashboard.dealAmount')} size="small">
            {data && (
              <Space orientation="vertical" size={4} style={{ width: '100%' }}>
                <Space style={{ justifyContent: 'space-between', width: '100%' }} align="start">
                  <Typography.Text type="secondary">{t('dashboard.amountAll')}</Typography.Text>
                  <Amounts sums={data.dealAmounts.all} testId="amount-all" />
                </Space>
                <Space style={{ justifyContent: 'space-between', width: '100%' }} align="start">
                  <Typography.Text type="secondary">{t('dashboard.amountOpen')}</Typography.Text>
                  <Amounts sums={data.dealAmounts.open} testId="amount-open" />
                </Space>
                <Space style={{ justifyContent: 'space-between', width: '100%' }} align="start">
                  <Typography.Text type="secondary">{t('dashboard.amountWon')}</Typography.Text>
                  <Amounts sums={data.dealAmounts.won} testId="amount-won" />
                </Space>
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card
            title={t('dashboard.myTodos')}
            loading={loading}
            extra={<Link href="/activities">{t('dashboard.viewAll')}</Link>}
            data-testid="my-todos"
          >
            {data && (
              <>
                <Typography.Text type="secondary">
                  {t('dashboard.todoSummary', { total: data.myTodoCount, overdue: data.myOverdueCount })}
                </Typography.Text>
                <List
                  dataSource={data.myTodos}
                  locale={{ emptyText: <Empty description={t('common.empty')} /> }}
                  renderItem={(a) => (
                    <List.Item>
                      <Space align="start">
                        <Checkbox
                          aria-label={`${t('activities.markDone')} ${a.subject}`}
                          checked={a.completed}
                          onChange={async () => {
                            try {
                              await toggleActivity(a);
                              void load();
                            } catch (err) {
                              message.error((err as Error).message);
                            }
                          }}
                        />
                        <div>
                          <Space size={4}>
                            <Tag color={ACTIVITY_TYPE_COLOR[a.type]}>{tEnum('activityType', a.type)}</Tag>
                            {a.subject}
                            {a.dueAt && dayjs(a.dueAt).isBefore(dayjs()) && <Tag color="red">{t('activities.overdue')}</Tag>}
                          </Space>
                          <div>
                            <Typography.Text type="secondary">
                              {a.dueAt ? fmtDateTime(a.dueAt) : ''} {related(a)}
                            </Typography.Text>
                          </div>
                        </div>
                      </Space>
                    </List.Item>
                  )}
                />
              </>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title={t('dashboard.recentActivities')} loading={loading} data-testid="recent-activities">
            <List
              dataSource={data?.recentActivities ?? []}
              locale={{ emptyText: <Empty description={t('common.empty')} /> }}
              renderItem={(a) => (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <Space size={4}>
                        <Tag color={ACTIVITY_TYPE_COLOR[a.type]}>{tEnum('activityType', a.type)}</Tag>
                        {a.subject}
                        {a.completed && <Tag color="green">{t('activities.completed')}</Tag>}
                      </Space>
                    }
                    description={`${fmtDateTime(a.createdAt)} · ${a.owner?.name ?? t('common.unassigned')} ${related(a)}`}
                  />
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>

      <Card title={t('dashboard.stages')} loading={loading}>
        <Table
          data-testid="stage-table"
          rowKey={(r) => `${r.stage}-${r.currency}`}
          size="small"
          pagination={false}
          dataSource={stageRows}
          locale={{ emptyText: t('common.empty') }}
          columns={[
            { title: t('deals.stage'), dataIndex: 'stage', render: (v: string) => tEnum('dealStage', v) },
            { title: t('dashboard.count'), dataIndex: 'count', align: 'right' },
            { title: t('dashboard.amount'), dataIndex: 'amount', align: 'right', render: (v: string, r) => fmtMoney(v, r.currency) },
          ]}
        />
      </Card>
    </Space>
  );
}
