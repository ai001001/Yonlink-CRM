/**
 * 知识库页：按状态、分类、关键词查找文章，查看详情（纯文本正文、浏览数、引用它的工单），新建草稿、修改，
 * 知识库管理员可发布、归档、退回草稿与删除。
 * Knowledge-base page: find articles by status, category and keyword; view details (plain-text body, views, linked
 * tickets); write drafts and edit; KB managers publish, archive, unpublish and delete.
 */
'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { App, AutoComplete, Button, Card, Checkbox, Descriptions, Drawer, Form, Input, Modal, Popconfirm, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { usePermissions } from '@/components/AuthProvider';
import { t, tEnum } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useOpenFromUrl, usePagedList, useSearch } from '@/lib/hooks';

const STATUS_COLOR: Record<string, string> = { DRAFT: 'default', PUBLISHED: 'green', ARCHIVED: 'orange' };

/** 文章 / Article */
interface Article {
  id: string;
  title: string;
  body?: string;
  excerpt?: string;
  category: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  publishedAt: string | null;
  viewCount: number;
  updatedAt: string;
  author: { id: string; name: string };
  _count: { tickets: number };
  editable: boolean;
  tickets?: { id: string; ticketNumber: string; subject: string; status: string }[];
}

interface ArticleForm {
  title: string;
  category?: string | null;
  body: string;
}

/**
 * 文章错误提示。
 * Messages for article errors.
 */
function articleError(err: unknown): string {
  const d = err instanceof ClientApiError ? err.details : undefined;
  if (d?.article?.[0] === 'stale') return t('kb.error.stale');
  return (err as Error).message;
}

export default function KnowledgeBasePage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canManage = perm.can('kb.manage');
  const search = useSearch();
  const [status, setStatus] = useState<string>('PUBLISHED');
  const [category, setCategory] = useState<string>();
  const [mine, setMine] = useState(false);
  const { data, loading, reload, pagination } = usePagedList<Article>('/api/kb/articles', {
    q: search.q || undefined,
    status: status === 'all' ? undefined : status,
    category,
    mine: mine ? 'true' : undefined,
  });
  const categories = (data as unknown as { categories?: string[] }).categories ?? [];
  const [detail, setDetail] = useState<Article | null>(null);
  const [editing, setEditing] = useState<Article | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<ArticleForm>();

  const openDetail = useCallback(
    (id: string) => {
      api<Article>(`/api/kb/articles/${id}?view=1`)
        .then(setDetail)
        .catch((err: Error) => message.error(err.message));
    },
    [message],
  );
  useOpenFromUrl(openDetail);

  const openForm = (a: Article | 'new') => {
    form.resetFields();
    if (a !== 'new') form.setFieldsValue({ title: a.title, category: a.category, body: a.body });
    setEditing(a);
  };

  /** 保存后刷新 / refresh after saving */
  const saved = (a: Article) => {
    message.success(t('common.saved'));
    void reload();
    if (detail?.id === a.id || editing === 'new') setDetail(a);
  };

  const save = async () => {
    const v = await form.validateFields();
    const body = { title: v.title, category: v.category ?? null, body: v.body };
    setSaving(true);
    try {
      const a = editing === 'new' ? await api<Article>('/api/kb/articles', { method: 'POST', body }) : await api<Article>(`/api/kb/articles/${(editing as Article).id}`, { method: 'PATCH', body });
      setEditing(null);
      saved(a);
    } catch (err) {
      message.error(articleError(err));
    } finally {
      setSaving(false);
    }
  };

  /** 改变状态 / change status */
  const setArticleStatus = async (a: Article, next: Article['status']) => {
    try {
      saved(await api<Article>(`/api/kb/articles/${a.id}`, { method: 'PATCH', body: { status: next } }));
    } catch (err) {
      message.error(articleError(err));
    }
  };

  const remove = async (a: Article) => {
    try {
      await api(`/api/kb/articles/${a.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      setDetail(null);
      void reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <Card
      title={t('kb.title')}
      extra={
        perm.can('record.create') && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm('new')}>
            {t('kb.new')}
          </Button>
        )
      }
    >
      <Segmented
        style={{ marginBottom: 16 }}
        value={status}
        onChange={(v) => setStatus(String(v))}
        options={[
          { value: 'PUBLISHED', label: tEnum('kbStatus', 'PUBLISHED') },
          { value: 'DRAFT', label: tEnum('kbStatus', 'DRAFT') },
          { value: 'ARCHIVED', label: tEnum('kbStatus', 'ARCHIVED') },
          { value: 'all', label: t('kb.all') },
        ]}
      />
      <Space wrap style={{ marginBottom: 16, display: 'flex' }}>
        <Input.Search allowClear placeholder={t('kb.searchPlaceholder')} style={{ width: 280 }} {...search.inputProps} />
        <Select allowClear aria-label={t('kb.category')} placeholder={t('kb.category')} style={{ width: 160 }} value={category} onChange={setCategory} options={categories.map((c) => ({ value: c, label: c }))} />
        <Checkbox checked={mine} onChange={(e) => setMine(e.target.checked)}>
          {t('kb.mine')}
        </Checkbox>
      </Space>
      <Table<Article>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('kb.articleTitle'),
            dataIndex: 'title',
            render: (v: string, r) => (
              <div style={{ maxWidth: 520 }}>
                <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openDetail(r.id)}>
                  {v}
                </Button>
                <div>
                  <Typography.Text type="secondary" ellipsis>
                    {r.excerpt}
                  </Typography.Text>
                </div>
              </div>
            ),
          },
          { title: t('kb.category'), dataIndex: 'category', render: (v: string | null) => (v ? <Tag>{v}</Tag> : null) },
          { title: t('kb.status'), dataIndex: 'status', render: (v: string) => <Tag color={STATUS_COLOR[v]}>{tEnum('kbStatus', v)}</Tag> },
          { title: t('kb.author'), render: (_, r) => r.author.name },
          { title: t('kb.views'), dataIndex: 'viewCount', align: 'right' },
          { title: t('kb.linkedTickets'), align: 'right', render: (_, r) => r._count.tickets },
          { title: t('kb.updatedAt'), render: (_, r) => fmtDateTime(r.updatedAt) },
        ]}
      />

      <Drawer
        title={detail ? detail.title : t('kb.detail')}
        size={760}
        open={detail !== null}
        onClose={() => setDetail(null)}
        extra={
          detail && (
            <Space wrap data-testid="kb-actions">
              {detail.editable && <Button onClick={() => openForm(detail)}>{t('common.edit')}</Button>}
              {canManage && detail.status !== 'PUBLISHED' && (
                <Button type="primary" onClick={() => setArticleStatus(detail, 'PUBLISHED')}>
                  {t('kb.action.publish')}
                </Button>
              )}
              {canManage && detail.status === 'PUBLISHED' && <Button onClick={() => setArticleStatus(detail, 'ARCHIVED')}>{t('kb.action.archive')}</Button>}
              {canManage && detail.status !== 'DRAFT' && <Button onClick={() => setArticleStatus(detail, 'DRAFT')}>{t('kb.action.unpublish')}</Button>}
              {detail.editable && (
                <Popconfirm title={t('kb.confirmDelete')} onConfirm={() => remove(detail)}>
                  <Button danger>{t('common.delete')}</Button>
                </Popconfirm>
              )}
            </Space>
          )
        }
      >
        {detail && (
          <div data-testid="kb-detail">
            <Descriptions column={2} size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label={t('kb.status')}>
                <Tag color={STATUS_COLOR[detail.status]}>{tEnum('kbStatus', detail.status)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('kb.category')}>{detail.category}</Descriptions.Item>
              <Descriptions.Item label={t('kb.author')}>{detail.author.name}</Descriptions.Item>
              <Descriptions.Item label={t('kb.publishedAt')}>{fmtDateTime(detail.publishedAt)}</Descriptions.Item>
              <Descriptions.Item label={t('kb.views')}>
                <span data-testid="kb-views">{detail.viewCount}</span>
              </Descriptions.Item>
              <Descriptions.Item label={t('kb.updatedAt')}>{fmtDateTime(detail.updatedAt)}</Descriptions.Item>
            </Descriptions>
            {/* 纯文本显示，不解析 HTML / plain text, never parsed as HTML */}
            <div data-testid="kb-body" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, marginBottom: 24 }}>
              {detail.body}
            </div>
            <Typography.Title level={5}>{t('kb.linkedTickets')}</Typography.Title>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={detail.tickets ?? []}
              locale={{ emptyText: t('common.empty') }}
              columns={[
                { title: t('tickets.number'), dataIndex: 'ticketNumber', width: 130 },
                { title: t('tickets.subject'), render: (_, r) => <Link href={`/tickets?id=${r.id}`}>{r.subject}</Link> },
                { title: t('tickets.status'), dataIndex: 'status', render: (v: string) => tEnum('ticketStatus', v) },
              ]}
            />
          </div>
        )}
      </Drawer>

      <Modal title={editing === 'new' ? t('kb.new') : t('kb.edit')} open={editing !== null} onOk={save} confirmLoading={saving} onCancel={() => setEditing(null)} okText={t('common.save')} width={760} forceRender zIndex={1100}>
        {editing === 'new' && <Typography.Paragraph type="secondary">{t('kb.draftHint')}</Typography.Paragraph>}
        <Form form={form} name="article" layout="vertical">
          <Form.Item name="title" label={t('kb.articleTitle')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('kb.articleTitle') }) }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="category" label={t('kb.category')}>
            <AutoComplete options={categories.map((c) => ({ value: c }))} maxLength={50} filterOption={(input, o) => String(o?.value ?? '').includes(input)} />
          </Form.Item>
          <Form.Item name="body" label={t('kb.body')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('kb.body') }) }]}>
            <Input.TextArea rows={14} maxLength={50000} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
