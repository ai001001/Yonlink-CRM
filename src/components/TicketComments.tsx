/**
 * 工单详情的“处理记录”：按时间先后列出评论（对外回复 / 内部备注），发表、修改自己的评论，删除自己的
 * （管理员、经理可删除任何评论）。
 * Ticket "Activity": comments oldest first (replies to the customer / internal notes); post, edit one's own and
 * delete one's own (admins and managers delete any).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Empty, Input, Popconfirm, Radio, Space, Tag, Typography } from 'antd';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useAuth, usePermissions } from './AuthProvider';

/** 工单评论 / Ticket comment */
interface Comment {
  id: string;
  body: string;
  isInternal: boolean;
  editedAt: string | null;
  createdAt: string;
  author: { id: string; name: string };
}

interface Props {
  ticket: { id: string; ownerId: string | null };
}

export function TicketComments({ ticket }: Props) {
  const { message } = App.useApp();
  const { me } = useAuth();
  const perm = usePermissions();
  const canPost = perm.canEdit(ticket);
  const [items, setItems] = useState<Comment[]>([]);
  const [body, setBody] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Comment[] }>(`/api/tickets/${ticket.id}/comments`)).items);
    } catch (err) {
      message.error((err as Error).message);
    }
  }, [ticket.id, message]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const send = async () => {
    setSending(true);
    try {
      await api(`/api/tickets/${ticket.id}/comments`, { method: 'POST', body: { body, isInternal } });
      setBody('');
      void load();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await api(`/api/ticket-comments/${editing.id}`, { method: 'PATCH', body: { body: editing.body } });
      setEditing(null);
      void load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const remove = async (c: Comment) => {
    try {
      await api(`/api/ticket-comments/${c.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      void load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <div data-testid="ticket-comments" style={{ marginBottom: 16 }}>
      <Typography.Title level={5}>{t('ticketComments.title')}</Typography.Title>
      {items.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('ticketComments.empty')} />}
      <Space orientation="vertical" size={8} style={{ width: '100%', marginBottom: 12 }}>
        {items.map((c) => {
          const mine = c.author.id === me?.id;
          return (
            <div
              key={c.id}
              data-testid="ticket-comment"
              style={{ padding: '8px 12px', borderRadius: 6, background: c.isInternal ? 'var(--ant-color-warning-bg, #fffbe6)' : 'var(--ant-color-fill-quaternary, #f5f5f5)' }}
            >
              <Space size={6} wrap style={{ marginBottom: 4 }}>
                <Typography.Text strong>{c.author.name}</Typography.Text>
                <Tag color={c.isInternal ? 'gold' : 'blue'}>{t(c.isInternal ? 'ticketComments.internal' : 'ticketComments.external')}</Tag>
                <Typography.Text type="secondary">{fmtDateTime(c.createdAt)}</Typography.Text>
                {c.editedAt && <Typography.Text type="secondary">{`(${t('ticketComments.edited')})`}</Typography.Text>}
                {mine && editing?.id !== c.id && (
                  <Button type="link" size="small" aria-label={`${t('common.edit')} ${c.id}`} onClick={() => setEditing({ id: c.id, body: c.body })}>
                    {t('common.edit')}
                  </Button>
                )}
                {(mine || perm.can('record.update.all')) && (
                  <Popconfirm title={t('ticketComments.confirmDelete')} onConfirm={() => remove(c)}>
                    <Button type="link" size="small" danger>
                      {t('common.delete')}
                    </Button>
                  </Popconfirm>
                )}
              </Space>
              {editing?.id === c.id ? (
                <Space orientation="vertical" style={{ width: '100%' }}>
                  <Input.TextArea aria-label={t('ticketComments.body')} rows={3} maxLength={5000} value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} />
                  <Space>
                    <Button size="small" type="primary" disabled={!editing.body.trim()} onClick={saveEdit}>
                      {t('common.save')}
                    </Button>
                    <Button size="small" onClick={() => setEditing(null)}>
                      {t('common.cancel')}
                    </Button>
                  </Space>
                </Space>
              ) : (
                <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
              )}
            </div>
          );
        })}
      </Space>
      {canPost && (
        <Space orientation="vertical" style={{ width: '100%' }} data-testid="ticket-comment-form">
          <Radio.Group value={isInternal} onChange={(e) => setIsInternal(e.target.value as boolean)}>
            <Radio value={false} title={t('ticketComments.externalHint')}>
              {t('ticketComments.external')}
            </Radio>
            <Radio value={true} title={t('ticketComments.internalHint')}>
              {t('ticketComments.internal')}
            </Radio>
          </Radio.Group>
          <Typography.Text type="secondary">{t(isInternal ? 'ticketComments.internalHint' : 'ticketComments.externalHint')}</Typography.Text>
          <Input.TextArea aria-label={t('ticketComments.title')} rows={3} maxLength={5000} placeholder={t('ticketComments.placeholder')} value={body} onChange={(e) => setBody(e.target.value)} />
          <Button type="primary" loading={sending} disabled={!body.trim()} onClick={send}>
            {t('ticketComments.send')}
          </Button>
        </Space>
      )}
    </div>
  );
}
