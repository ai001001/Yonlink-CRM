/**
 * 工作台：数量统计、商机金额汇总、我的待办、我的待处理工单、最近跟进、即将成交、阶段分布（全部来自数据库实时数据）。
 * 显示哪些卡片及顺序由个人布局决定，可在“自定义工作台”中修改。
 * Dashboard: counts, deal amounts, my to-dos, my pending tickets, recent activities, closing soon and stage breakdown (live data).
 * Which cards show and their order follow the personal layout, editable via “Customise dashboard”.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { App, Button, Card, Checkbox, Col, Empty, List, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import { BankOutlined, FundOutlined, SettingOutlined, UserAddOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useAuth, usePermissions } from '@/components/AuthProvider';
import { DashboardCustomizer, type DashboardWidget } from '@/components/DashboardCustomizer';
import { ACTIVITY_TYPE_COLOR, toggleActivity } from '@/components/RelatedActivities';
import { t, tEnum } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import type { Activity } from '@/lib/types';

interface Sum {
  currency: string;
  amount: string;
}

/** 即将成交的商机 / Deal closing soon */
interface SoonDeal {
  id: string;
  name: string;
  amount: string;
  currency: string;
  stage: string;
  expectedCloseDate: string;
  account: { id: string; name: string };
  owner: { id: string; name: string } | null;
}

/** 我的待处理工单 / My pending ticket */
interface MyTicket {
  id: string;
  ticketNumber: string;
  subject: string;
  status: string;
  priority: string;
  dueAt: string | null;
  overdue: boolean;
  account: { id: string; name: string };
}

const PRIORITY_COLOR: Record<string, string> = { URGENT: 'red', HIGH: 'volcano', MEDIUM: 'gold', LOW: 'default' };

/** 工作台数据：隐藏的卡片对应字段为 null / dashboard data: hidden cards come back as null */
interface Dashboard {
  layout: DashboardWidget[];
  counts: { accounts: number; leads: number; deals: number } | null;
  dealAmounts: { all: Sum[]; open: Sum[]; won: Sum[] } | null;
  stages: { stage: string; currency: string; count: number; amount: string }[] | null;
  recentActivities: Activity[] | null;
  myTodos: Activity[] | null;
  myTodoCount: number | null;
  myOverdueCount: number | null;
  closingSoon: { items: SoonDeal[]; total: number; days: number } | null;
  myTickets: { items: MyTicket[]; total: number; overdue: number } | null;
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
  const perm = usePermissions();
  const { message } = App.useApp();
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [customizing, setCustomizing] = useState(false);

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
  const today = dayjs().format('YYYY-MM-DD');

  /** 各卡片（含栅格宽度）/ each card with its grid width */
  const widgets: Record<DashboardWidget, () => React.ReactNode> = {
    counts: () => (
      <Col key="counts" xs={24} xl={18} data-testid="widget-counts">
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={8}>
            <Card>
              <Link href="/accounts">
                <Statistic title={t('dashboard.accounts')} value={data?.counts?.accounts ?? 0} prefix={<BankOutlined />} data-testid="kpi-accounts" />
              </Link>
            </Card>
          </Col>
          <Col xs={24} sm={8}>
            <Card>
              <Link href="/leads">
                <Statistic title={t('dashboard.leads')} value={data?.counts?.leads ?? 0} prefix={<UserAddOutlined />} data-testid="kpi-leads" />
              </Link>
            </Card>
          </Col>
          <Col xs={24} sm={8}>
            <Card>
              <Link href="/deals">
                <Statistic title={t('dashboard.deals')} value={data?.counts?.deals ?? 0} prefix={<FundOutlined />} data-testid="kpi-deals" />
              </Link>
            </Card>
          </Col>
        </Row>
      </Col>
    ),
    dealAmounts: () => (
      <Col key="dealAmounts" xs={24} xl={6} data-testid="widget-dealAmounts">
        <Card title={t('dashboard.dealAmount')} size="small">
          {data?.dealAmounts && (
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
    ),
    myTodos: () => (
      <Col key="myTodos" xs={24} xl={12} data-testid="widget-myTodos">
        <Card title={t('dashboard.myTodos')} extra={<Link href="/activities">{t('dashboard.viewAll')}</Link>} data-testid="my-todos">
          <Typography.Text type="secondary">{t('dashboard.todoSummary', { total: data?.myTodoCount ?? 0, overdue: data?.myOverdueCount ?? 0 })}</Typography.Text>
          <List
            dataSource={data?.myTodos ?? []}
            locale={{ emptyText: <Empty description={t('common.empty')} /> }}
            renderItem={(a) => (
              <List.Item>
                <Space align="start">
                  <Checkbox
                    aria-label={`${t('activities.markDone')} ${a.subject}`}
                    checked={a.completed}
                    disabled={!perm.canEdit(a)}
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
        </Card>
      </Col>
    ),
    myTickets: () => (
      <Col key="myTickets" xs={24} xl={12} data-testid="widget-myTickets">
        <Card title={t('dashboard.myTickets')} extra={<Link href="/tickets">{t('dashboard.viewAll')}</Link>} data-testid="my-tickets">
          <Typography.Text type="secondary">{t('dashboard.ticketSummary', { total: data?.myTickets?.total ?? 0, overdue: data?.myTickets?.overdue ?? 0 })}</Typography.Text>
          <List
            dataSource={data?.myTickets?.items ?? []}
            locale={{ emptyText: <Empty description={t('common.empty')} /> }}
            renderItem={(tk) => (
              <List.Item>
                <List.Item.Meta
                  title={
                    <Space size={4} wrap>
                      <Tag color={PRIORITY_COLOR[tk.priority]}>{tEnum('ticketPriority', tk.priority)}</Tag>
                      <Link href={`/tickets?id=${tk.id}`}>{tk.subject}</Link>
                      {tk.overdue && <Tag color="red">{t('tickets.overdue')}</Tag>}
                    </Space>
                  }
                  description={`${tk.ticketNumber} · ${tEnum('ticketStatus', tk.status)} · ${tk.account.name}${tk.dueAt ? ` · ${t('tickets.dueAt')}${t('common.colon')}${fmtDateTime(tk.dueAt)}` : ''}`}
                />
              </List.Item>
            )}
          />
        </Card>
      </Col>
    ),
    recentActivities: () => (
      <Col key="recentActivities" xs={24} xl={12} data-testid="widget-recentActivities">
        <Card title={t('dashboard.recentActivities')} data-testid="recent-activities">
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
    ),
    closingSoon: () => (
      <Col key="closingSoon" xs={24} xl={12} data-testid="widget-closingSoon">
        <Card
          title={t('dashboard.closingSoon', { days: data?.closingSoon?.days ?? 30 })}
          extra={<Typography.Text type="secondary">{t('common.total', { total: data?.closingSoon?.total ?? 0 })}</Typography.Text>}
          data-testid="closing-soon"
        >
          <List
            dataSource={data?.closingSoon?.items ?? []}
            locale={{ emptyText: <Empty description={t('common.empty')} /> }}
            renderItem={(d) => (
              <List.Item extra={fmtMoney(d.amount, d.currency)}>
                <List.Item.Meta
                  title={
                    <Space size={4} wrap>
                      <Link href={`/deals?id=${d.id}`}>{d.name}</Link>
                      <Tag>{tEnum('dealStage', d.stage)}</Tag>
                      {d.expectedCloseDate.slice(0, 10) < today && <Tag color="red">{t('deals.overdueClose')}</Tag>}
                    </Space>
                  }
                  description={`${fmtDate(d.expectedCloseDate.slice(0, 10))} · ${d.account.name} · ${d.owner?.name ?? t('common.unassigned')}`}
                />
              </List.Item>
            )}
          />
        </Card>
      </Col>
    ),
    stages: () => (
      <Col key="stages" xs={24} data-testid="widget-stages">
        <Card title={t('dashboard.stages')}>
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
      </Col>
    ),
  };

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t('dashboard.welcome', { name: me?.name ?? '' })}
        </Typography.Title>
        <Button icon={<SettingOutlined />} disabled={!data} onClick={() => setCustomizing(true)}>
          {t('dashboard.customize')}
        </Button>
      </Space>
      {loading && <Card loading />}
      {data && <Row gutter={[16, 16]}>{data.layout.map((w) => widgets[w]())}</Row>}
      {data && (
        <DashboardCustomizer
          key={customizing ? 'open' : 'closed'}
          open={customizing}
          current={data.layout}
          onClose={() => setCustomizing(false)}
          onSaved={() => {
            setCustomizing(false);
            void load();
          }}
        />
      )}
    </Space>
  );
}
