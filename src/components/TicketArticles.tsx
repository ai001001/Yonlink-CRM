/**
 * 工单详情的“知识库文章”：列出已关联的文章（点击打开知识库），能编辑工单的用户可搜索已发布文章并关联或取消关联。
 * Ticket "Knowledge base": linked articles (open in the knowledge base); ticket editors search published articles and
 * link or unlink them.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { App, Button, List, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { t, tEnum } from '@/i18n';
import { api, ClientApiError, qs } from '@/lib/api';
import { usePermissions } from './AuthProvider';

interface Linked {
  id: string;
  title: string;
  category: string | null;
  status: string;
  linkedBy: { id: string; name: string };
}

interface Props {
  ticket: { id: string; ownerId: string | null };
}

export function TicketArticles({ ticket }: Props) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const editable = perm.canEdit(ticket);
  const [items, setItems] = useState<Linked[]>([]);
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Linked[] }>(`/api/tickets/${ticket.id}/articles`)).items);
    } catch (err) {
      message.error((err as Error).message);
    }
  }, [ticket.id, message]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const search = (q: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const r = await api<{ items: { id: string; title: string }[] }>(`/api/kb/articles${qs({ q, status: 'PUBLISHED', pageSize: 20 })}`);
        setOptions(r.items.map((a) => ({ value: a.id, label: a.title })));
      } catch {
        setOptions([]);
      }
    }, 250);
  };

  useEffect(() => {
    if (editable) search('');
    return () => clearTimeout(timer.current);
  }, [editable]);

  const link = async (articleId: string) => {
    try {
      setItems((await api<{ items: Linked[] }>(`/api/tickets/${ticket.id}/articles`, { method: 'POST', body: { articleId } })).items);
      message.success(t('common.saved'));
    } catch (err) {
      message.error(err instanceof ClientApiError && err.details?.articleId?.[0] === 'duplicate' ? t('kb.error.duplicateLink') : (err as Error).message);
    }
  };

  const unlink = async (a: Linked) => {
    try {
      await api(`/api/tickets/${ticket.id}/articles/${a.id}`, { method: 'DELETE' });
      void load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const linked = new Set(items.map((i) => i.id));
  return (
    <div data-testid="ticket-articles" style={{ marginBottom: 16 }}>
      <Typography.Title level={5}>{t('kb.ticketSection')}</Typography.Title>
      {editable && (
        <Select
          aria-label={t('kb.linkArticle')}
          placeholder={t('kb.linkArticle')}
          style={{ width: '100%', marginBottom: 8 }}
          showSearch={{ filterOption: false, onSearch: search }}
          value={null}
          onChange={(id: string) => void link(id)}
          options={options.filter((o) => !linked.has(o.value))}
          notFoundContent={null}
        />
      )}
      <List
        size="small"
        bordered
        dataSource={items}
        locale={{ emptyText: t('kb.noLinked') }}
        renderItem={(a) => (
          <List.Item
            actions={
              editable
                ? [
                    <Popconfirm key="unlink" title={t('kb.confirmUnlink')} onConfirm={() => unlink(a)}>
                      <Button type="link" size="small" danger aria-label={`${t('kb.unlink')} ${a.title}`}>
                        {t('kb.unlink')}
                      </Button>
                    </Popconfirm>,
                  ]
                : []
            }
          >
            <Space size={4} wrap>
              <Link href={`/kb?id=${a.id}`}>{a.title}</Link>
              {a.category && <Tag>{a.category}</Tag>}
              {a.status !== 'PUBLISHED' && <Tag color="orange">{tEnum('kbStatus', a.status)}</Tag>}
            </Space>
          </List.Item>
        )}
      />
    </div>
  );
}
