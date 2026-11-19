/**
 * 报表页“阶段停留时长”卡片：各进行中阶段已结束停留的平均天数与次数、目前处于该阶段的商机数与已停留平均天数，以及成交周期。
 * 与报表页共用时间段与负责人筛选。
 * Reports "Stage duration" card: per open stage, average days and count of completed stays and of deals currently in
 * the stage, plus the sales cycle. Shares the reports page's period and owner filters.
 */
'use client';

import { useEffect, useState } from 'react';
import { Card, Space, Statistic, Table, Typography } from 'antd';
import { t, tEnum } from '@/i18n';
import { api, qs } from '@/lib/api';

/** 统计值 / a statistic */
interface Stat {
  count: number;
  avgDays: number | null;
}

interface StageDuration {
  stages: { stage: string; completed: Stat; current: Stat }[];
  cycle: { won: Stat; lost: Stat };
}

/** 天数显示 / days display */
const d = (v: number | null) => (v === null ? '—' : t('stageHistory.avgDays', { n: v }));

export function StageDurationCard({ from, to, ownerId }: { from: string; to: string; ownerId?: string }) {
  const [data, setData] = useState<StageDuration | null>(null);

  useEffect(() => {
    let alive = true;
    api<StageDuration>(`/api/reports/stage-duration${qs({ from, to, ownerId })}`)
      .then((r) => alive && setData(r))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [from, to, ownerId]);

  return (
    <Card size="small" title={t('stageHistory.report')} extra={<Typography.Text type="secondary">{t('stageHistory.reportHint')}</Typography.Text>} style={{ marginTop: 16 }} data-testid="stage-duration">
      <Table
        data-testid="table-stage-duration"
        rowKey="stage"
        size="small"
        pagination={false}
        scroll={{ x: 'max-content' }}
        loading={!data}
        dataSource={data?.stages ?? []}
        columns={[
          { title: t('deals.stage'), render: (_, r) => tEnum('dealStage', r.stage) },
          { title: t('stageHistory.col.completedAvg'), align: 'right', render: (_, r) => d(r.completed.avgDays) },
          { title: t('stageHistory.col.completedCount'), align: 'right', render: (_, r) => r.completed.count },
          { title: t('stageHistory.col.currentCount'), align: 'right', render: (_, r) => r.current.count },
          { title: t('stageHistory.col.currentAvg'), align: 'right', render: (_, r) => d(r.current.avgDays) },
        ]}
      />
      {data && (
        <Space size="large" style={{ marginTop: 16 }} wrap>
          <Statistic title={t('stageHistory.cycleWon', { n: data.cycle.won.count })} value={d(data.cycle.won.avgDays)} />
          <Statistic title={t('stageHistory.cycleLost', { n: data.cycle.lost.count })} value={d(data.cycle.lost.avgDays)} />
        </Space>
      )}
    </Card>
  );
}
