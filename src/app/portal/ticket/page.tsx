/**
 * 客户门户工单详情：/portal/ticket?id=…；工单信息、处理结果、公开的沟通记录与回复框。
 * Customer portal ticket detail: /portal/ticket?id=…; ticket info, resolution, the public conversation and a reply box.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Empty, Input, Space, Tag, Typography } from 'antd';
import { PortalShell } from '@/components/PortalShell';
import { t, tEnum } from '@/i18n';
import { fmtDateTime } from '@/lib/format';
import { portalApi, siteUrl } from '@/lib/portal-api';

interface Detail {
  id: string;
  ticketNumber: string;
  subject: string;
  description: string | null;
  status: string;
  type: string;
  resolution: string | null;
  createdAt: string;
  comments: { id: string; body: string; createdAt: string; author: { kind: 'staff'; name: string } | { kind: 'customer'; name: string | null; mine: boolean } }[];
}

function TicketDetail() {
  const { message } = App.useApp();
  const [id, setId] = useState<string | null>(null);
  const [data, setData] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    // 静态导出页面只能在加载后读取地址参数 / statically exported pages read URL parameters after loading
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setId(new URLSearchParams(window.location.search).get('id'));
  }, []);
  const load = useCallback(() => {
    if (!id) return;
    portalApi<Detail>(`/api/portal/tickets/${id}`)
      .then(setData)
      .catch(() => setMissing(true));
  }, [id]);
  useEffect(load, [load]);

  const send = async () => {
    if (!reply.trim() || !id) return;
    setSending(true);
    try {
      const r = await portalApi<{ reopened: boolean }>(`/api/portal/tickets/${id}/comments`, { method: 'POST', body: { body: reply } });
      message.success(t(r.reopened ? 'portal.reopened' : 'portal.replied'));
      setReply('');
      load();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const back = (
    <Button href={siteUrl('portal')} style={{ marginBottom: 12 }}>
      {t('portal.back')}
    </Button>
  );
  if (missing) return <>{back}<Alert type="warning" showIcon message={t('error.NOT_FOUND')} /></>;
  if (!data) return back;
  return (
    <>
      {back}
      <Card title={`${data.ticketNumber} · ${data.subject}`} extra={<Tag data-testid="portal-ticket-status">{tEnum('ticketStatus', data.status)}</Tag>}>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label={t('portal.type')}>{tEnum('ticketType', data.type)}</Descriptions.Item>
          <Descriptions.Item label={t('portal.createdAt')}>{fmtDateTime(data.createdAt)}</Descriptions.Item>
          <Descriptions.Item label={t('portal.description')}>
            <span style={{ whiteSpace: 'pre-wrap' }}>{data.description}</span>
          </Descriptions.Item>
          {data.resolution && (
            <Descriptions.Item label={t('portal.resolution')}>
              <span style={{ whiteSpace: 'pre-wrap' }}>{data.resolution}</span>
            </Descriptions.Item>
          )}
        </Descriptions>
        <Typography.Title level={5} style={{ marginTop: 16 }}>
          {t('portal.conversation')}
        </Typography.Title>
        {data.comments.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('portal.noComments')} />}
        <Space orientation="vertical" size={8} style={{ width: '100%' }} data-testid="portal-comments">
          {data.comments.map((c) => (
            <div key={c.id} style={{ padding: '8px 12px', borderRadius: 6, background: c.author.kind === 'staff' ? '#e6f4ff' : '#f5f5f5' }}>
              <Space size={6} wrap style={{ marginBottom: 4 }}>
                <Typography.Text strong>{c.author.kind === 'staff' ? t('portal.support', { name: c.author.name }) : c.author.mine ? t('portal.me') : (c.author.name ?? t('portal.deletedCustomer'))}</Typography.Text>
                <Typography.Text type="secondary">{fmtDateTime(c.createdAt)}</Typography.Text>
              </Space>
              <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
            </div>
          ))}
        </Space>
        {data.status === 'CLOSED' ? (
          <Alert style={{ marginTop: 16 }} type="info" showIcon message={t('portal.closedHint')} />
        ) : (
          <div style={{ marginTop: 16 }}>
            <Input.TextArea rows={3} maxLength={5000} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t('portal.replyPlaceholder')} aria-label={t('portal.reply')} />
            <Button type="primary" style={{ marginTop: 8 }} loading={sending} disabled={!reply.trim()} onClick={() => void send()}>
              {t('portal.reply')}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}

export default function PortalTicketPage() {
  return (
    <PortalShell>
      <TicketDetail />
    </PortalShell>
  );
}
