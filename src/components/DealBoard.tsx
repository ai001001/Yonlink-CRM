/**
 * 商机销售漏斗看板：按阶段分列，拖动卡片（或使用卡片上的“移动到”）更新阶段。
 * Deal pipeline board: columns per stage; drag a card (or use its “Move to” select) to change the stage.
 */
'use client';

import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { App, Button, Card, Empty, Select, Space, Spin, Tag, Typography } from 'antd';
import { t, tEnum } from '@/i18n';
import { api, qs } from '@/lib/api';
import { fmtDate, fmtMoney } from '@/lib/format';
import type { Deal } from '@/lib/types';
import { usePermissions } from './AuthProvider';

interface Column {
  stage: Deal['stage'];
  count: number;
  sums: { currency: string; amount: string }[];
  items: Deal[];
  hasMore: boolean;
}

const STAGE_COLOR: Record<string, string> = {
  QUALIFICATION: '#8c8c8c',
  NEEDS_ANALYSIS: '#1677ff',
  PROPOSAL: '#13a8a8',
  NEGOTIATION: '#fa8c16',
  CLOSED_WON: '#52c41a',
  CLOSED_LOST: '#f5222d',
};

interface Props {
  /** 搜索词（与列表共用）/ search term shared with the list */
  q: string;
  /** 变化时重新加载 / reload when it changes */
  version: number;
  /** 打开详情 / open the detail drawer */
  onOpen: (deal: Deal) => void;
}

export function DealBoard({ q, version, onOpen }: Props) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const [columns, setColumns] = useState<Column[] | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setColumns((await api<{ columns: Column[] }>(`/api/deals/board${qs({ q })}`)).columns);
    } catch (err) {
      message.error((err as Error).message);
    }
  }, [q, message]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, version]);

  /**
   * 移动卡片：先在界面上移动，服务端失败则恢复，成功后刷新以更新合计。
   * Move a card optimistically; restore on server failure, then reload to refresh totals.
   */
  const move = async (deal: Deal, stage: Deal['stage']) => {
    if (deal.stage === stage || !columns) return;
    const previous = columns;
    setColumns(
      columns.map((c) => {
        if (c.stage === deal.stage) return { ...c, count: c.count - 1, items: c.items.filter((d) => d.id !== deal.id) };
        if (c.stage === stage) return { ...c, count: c.count + 1, items: [{ ...deal, stage }, ...c.items] };
        return c;
      }),
    );
    try {
      await api(`/api/deals/${deal.id}`, { method: 'PATCH', body: { stage } });
      message.success(t('deals.moved', { stage: tEnum('dealStage', stage) }));
    } catch (err) {
      setColumns(previous);
      message.error((err as Error).message);
    } finally {
      void load();
    }
  };

  const findDeal = (id: string) => columns?.flatMap((c) => c.items).find((d) => d.id === id);

  const onDrop = (e: DragEvent, stage: Deal['stage']) => {
    e.preventDefault();
    setDragOver(null);
    const deal = findDeal(e.dataTransfer.getData('text/plain'));
    if (deal) void move(deal, stage);
  };

  if (!columns) return <Spin />;

  return (
    <>
      <Typography.Paragraph type="secondary">{t('deals.dragHint')}</Typography.Paragraph>
      <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
        {columns.map((col) => (
          <div
            key={col.stage}
            data-testid={`board-col-${col.stage}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(col.stage);
            }}
            onDragLeave={() => setDragOver((s) => (s === col.stage ? null : s))}
            onDrop={(e) => onDrop(e, col.stage)}
            style={{
              flex: '0 0 240px',
              background: dragOver === col.stage ? '#e6f4ff' : '#f5f7fa',
              borderRadius: 8,
              borderTop: `3px solid ${STAGE_COLOR[col.stage]}`,
              padding: 8,
              minHeight: 320,
            }}
          >
            <div style={{ padding: '4px 4px 8px' }}>
              <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                <Typography.Text strong>{tEnum('dealStage', col.stage)}</Typography.Text>
                <Tag data-testid="board-col-count">{col.count}</Tag>
              </Space>
              <div data-testid="board-col-sum">
                {(col.sums.length ? col.sums : [{ currency: 'CNY', amount: '0' }]).map((s) => (
                  <Typography.Text key={s.currency} type="secondary" style={{ display: 'block', fontSize: 12 }}>
                    {fmtMoney(s.amount, s.currency)}
                  </Typography.Text>
                ))}
              </div>
            </div>
            <Space orientation="vertical" size={8} style={{ width: '100%' }}>
              {col.items.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('deals.emptyColumn')} />}
              {col.items.map((deal) => {
                const editable = perm.canEdit(deal);
                return (
                  <Card
                    key={deal.id}
                    size="small"
                    data-testid="deal-card"
                    aria-label={deal.name}
                    draggable={editable}
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', deal.id)}
                    style={{ cursor: editable ? 'grab' : 'default' }}
                  >
                    <Button type="link" size="small" style={{ padding: 0, fontWeight: 500 }} onClick={() => onOpen(deal)}>
                      {deal.name}
                    </Button>
                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {deal.account.name}
                      </Typography.Text>
                    </div>
                    <div style={{ margin: '4px 0' }}>{fmtMoney(deal.amount, deal.currency)}</div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {fmtDate(deal.expectedCloseDate?.slice(0, 10))} {deal.owner?.name ?? t('common.unassigned')}
                    </Typography.Text>
                    {editable && (
                      <Select
                        size="small"
                        style={{ width: '100%', marginTop: 6 }}
                        aria-label={`${t('deals.moveTo')} ${deal.name}`}
                        placeholder={t('deals.moveTo')}
                        value={null}
                        options={columns.filter((c) => c.stage !== deal.stage).map((c) => ({ value: c.stage, label: tEnum('dealStage', c.stage) }))}
                        onChange={(stage: Deal['stage']) => void move(deal, stage)}
                      />
                    )}
                  </Card>
                );
              })}
              {col.hasMore && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('deals.columnMore', { n: col.count - col.items.length })}
                </Typography.Text>
              )}
            </Space>
          </div>
        ))}
      </div>
    </>
  );
}
