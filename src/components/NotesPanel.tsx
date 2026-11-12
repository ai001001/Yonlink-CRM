/**
 * 备注时间线（线索/客户/商机详情）：新增、编辑（仅作者）、删除（作者或有删除权限）。按纯文本显示。
 * Notes timeline for lead / account / deal details: add, edit (author only), delete (author or delete permission).
 * Content is rendered as plain text.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Avatar, Button, Empty, Input, List, Popconfirm, Space, Typography } from 'antd';
import { t } from '@/i18n';
import { api, qs } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useAuth, usePermissions } from './AuthProvider';

/** 备注 / Note */
interface Note {
  id: string;
  content: string;
  author: { id: string; name: string };
  createdAt: string;
  editedAt: string | null;
}

interface Props {
  /** 所属记录 / parent record */
  parent: { leadId: string } | { accountId: string } | { dealId: string };
  /** 所属记录的负责人（判断能否新增）/ owner of the parent (decides whether notes can be added) */
  ownerId: string | null;
}

const MAX = 5000;

export function NotesPanel({ parent, ownerId }: Props) {
  const { message } = App.useApp();
  const { me } = useAuth();
  const perm = usePermissions();
  const [items, setItems] = useState<Note[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const key = JSON.stringify(parent);
  const canAdd = perm.canEdit({ ownerId });

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Note[] }>(`/api/notes${qs(JSON.parse(key))}`)).items);
    } catch (err) {
      message.error((err as Error).message);
    }
  }, [key, message]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      await api('/api/notes', { method: 'POST', body: { content: text, ...JSON.parse(key) } });
      setDraft('');
      message.success(t('notes.added'));
      void load();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editing || !editing.text.trim()) return;
    try {
      await api(`/api/notes/${editing.id}`, { method: 'PATCH', body: { content: editing.text } });
      setEditing(null);
      message.success(t('common.saved'));
      void load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/api/notes/${id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      void load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <div data-testid="notes-panel">
      {canAdd && (
        <Space.Compact block style={{ marginBottom: 12, alignItems: 'flex-start' }}>
          <Input.TextArea
            aria-label={t('notes.add')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('notes.placeholder')}
            autoSize={{ minRows: 2, maxRows: 6 }}
            maxLength={MAX}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void add();
            }}
          />
          <Button type="primary" loading={busy} disabled={!draft.trim()} onClick={add}>
            {t('notes.add')}
          </Button>
        </Space.Compact>
      )}
      <List
        dataSource={items}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('notes.empty')} /> }}
        renderItem={(n) => {
          const mine = n.author.id === me?.id;
          const canDelete = mine || perm.canDelete;
          return (
            <List.Item
              data-testid="note-item"
              actions={[
                mine && editing?.id !== n.id && (
                  <Button key="edit" type="link" size="small" onClick={() => setEditing({ id: n.id, text: n.content })}>
                    {t('common.edit')}
                  </Button>
                ),
                canDelete && (
                  <Popconfirm key="del" title={t('notes.confirmDelete')} onConfirm={() => remove(n.id)}>
                    <Button type="link" size="small" danger>
                      {t('common.delete')}
                    </Button>
                  </Popconfirm>
                ),
              ].filter(Boolean)}
            >
              <List.Item.Meta
                avatar={<Avatar style={{ background: '#1f5fbf' }}>{n.author.name.slice(0, 1)}</Avatar>}
                title={
                  <Space size={8}>
                    <Typography.Text strong>{n.author.name}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {fmtDateTime(n.createdAt)}
                      {n.editedAt && ` · ${t('notes.edited')} ${fmtDateTime(n.editedAt)}`}
                    </Typography.Text>
                  </Space>
                }
                description={
                  editing?.id === n.id ? (
                    <Space orientation="vertical" style={{ width: '100%' }}>
                      <Input.TextArea
                        aria-label={t('common.edit')}
                        value={editing.text}
                        maxLength={MAX}
                        autoSize={{ minRows: 2, maxRows: 8 }}
                        onChange={(e) => setEditing({ id: n.id, text: e.target.value })}
                      />
                      <Space>
                        <Button size="small" type="primary" onClick={saveEdit} disabled={!editing.text.trim()}>
                          {t('common.save')}
                        </Button>
                        <Button size="small" onClick={() => setEditing(null)}>
                          {t('common.cancel')}
                        </Button>
                      </Space>
                    </Space>
                  ) : (
                    <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0, color: 'inherit' }}>{n.content}</Typography.Paragraph>
                  )
                }
              />
            </List.Item>
          );
        }}
      />
    </div>
  );
}
