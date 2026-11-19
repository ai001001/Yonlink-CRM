/**
 * 商机详情的“阶段历史”页签：每次阶段、金额、币种、预计成交日变化的记录（最新在前），含停留时长、可能性、预期收入与修改人。
 * 历史由服务端自动记录，只能查看。
 * Deal "Stage history" tab: every change of stage, amount, currency or expected close date (newest first) with
 * duration, probability, expected revenue and the actor. Recorded automatically by the server; read-only.
 */
'use client';

import { useEffect, useState } from 'react';
import { Table, Tag, Typography } from 'antd';
import { t, tEnum } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';

/** 历史行 / history row */
interface StageRow {
  id: string;
  stage: string;
  amount: string;
  currency: string;
  expectedCloseDate: string | null;
  changedAt: string;
  changedBy: { id: string; name: string } | null;
  stageChanged: boolean;
  current: boolean;
  durationMs: number | null;
  probability: number;
  expectedRevenue: string;
}

/**
 * 停留时长的显示：不足 1 小时、N 小时、N 天 M 小时。
 * Display a duration: under an hour, N hours, or N days M hours.
 */
export function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return t('stageHistory.lessThanHour');
  if (hours < 24) return t('stageHistory.hours', { n: hours });
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? t('stageHistory.daysHours', { d, h }) : t('stageHistory.days', { d });
}

export function DealStageHistoryPanel({ dealId, version }: { dealId: string; version?: string }) {
  const [rows, setRows] = useState<StageRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api<{ items: StageRow[] }>(`/api/deals/${dealId}/stage-history`)
      .then((r) => alive && setRows(r.items))
      .catch(() => alive && setRows([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // 商机更新后（version 变化）重新加载 / reload after the deal changes
  }, [dealId, version]);

  return (
    <div data-testid="stage-history">
      <Typography.Paragraph type="secondary">{t('stageHistory.hint')}</Typography.Paragraph>
      <Table<StageRow>
        rowKey="id"
        size="small"
        loading={loading}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        scroll={{ x: 'max-content' }}
        dataSource={rows}
        locale={{ emptyText: t('common.empty') }}
        columns={[
          {
            title: t('deals.stage'),
            render: (_, r) => (
              <span>
                <Tag color={r.stage === 'CLOSED_WON' ? 'green' : r.stage === 'CLOSED_LOST' ? 'red' : r.stageChanged ? 'blue' : 'default'}>{tEnum('dealStage', r.stage)}</Tag>
                {r.current && <Tag color="gold">{t('stageHistory.current')}</Tag>}
              </span>
            ),
          },
          { title: t('deals.amount'), align: 'right', render: (_, r) => fmtMoney(r.amount, r.currency) },
          { title: t('stageHistory.probability'), align: 'right', render: (_, r) => `${r.probability}%` },
          { title: t('stageHistory.expectedRevenue'), align: 'right', render: (_, r) => fmtMoney(r.expectedRevenue, r.currency) },
          { title: t('deals.expectedCloseDate'), render: (_, r) => fmtDate(r.expectedCloseDate) || '—' },
          { title: t('stageHistory.duration'), render: (_, r) => fmtDuration(r.durationMs) },
          { title: t('stageHistory.changedBy'), render: (_, r) => r.changedBy?.name ?? t('stageHistory.system') },
          { title: t('stageHistory.changedAt'), render: (_, r) => fmtDateTime(r.changedAt) },
        ]}
      />
    </div>
  );
}
