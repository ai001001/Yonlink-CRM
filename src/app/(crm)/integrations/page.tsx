/**
 * 集成页（设置 › 集成，需 integration.manage）：API 密钥（新建后只显示一次、吊销）与 Webhook（新建、编辑、启停、测试、
 * 重新生成签名密钥、删除、投递记录与手动重试）。
 * Integrations page (Setup › Integrations, integration.manage): API keys (shown once after creation, revoke) and
 * webhooks (create, edit, toggle, test, regenerate the signing secret, delete, deliveries and manual retry).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, DatePicker, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { t, tEnum } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useOwners } from '@/lib/hooks';

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  user: { id: string; name: string; role: string; isActive: boolean };
  createdBy: { id: string; name: string } | null;
}
interface WebhookRow {
  id: string;
  name: string;
  url: string;
  isActive: boolean;
  createdAt: string;
  deliveries: Record<'PENDING' | 'SUCCEEDED' | 'FAILED', number>;
}
interface Delivery {
  id: string;
  event: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  attempts: number;
  nextAttemptAt: string;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  payload: unknown;
}

const DELIVERY_COLOR = { PENDING: 'blue', SUCCEEDED: 'green', FAILED: 'red' } as const;

/** 密钥或签名密钥只显示一次的弹窗 / a dialog that shows a secret once */
function SecretModal({ title, value, onClose }: { title: string; value: string | null; onClose: () => void }) {
  return (
    <Modal title={title} open={value !== null} onCancel={onClose} onOk={onClose} cancelButtonProps={{ style: { display: 'none' } }} okText={t('integrations.copiedClose')}>
      <Alert type="warning" showIcon title={t('integrations.showOnce')} style={{ marginBottom: 12 }} />
      <Typography.Paragraph copyable={{ text: value ?? '' }} code data-testid="secret-value" style={{ wordBreak: 'break-all' }}>
        {value}
      </Typography.Paragraph>
    </Modal>
  );
}

/** API 密钥卡片 / API keys card */
function ApiKeysCard() {
  const { message } = App.useApp();
  const owners = useOwners();
  const [rows, setRows] = useState<ApiKeyRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [form] = Form.useForm<{ name: string; userId: string; expiresOn?: Dayjs | null }>();

  const load = useCallback(() => {
    api<{ items: ApiKeyRow[] }>('/api/api-keys')
      .then((r) => setRows(r.items))
      .catch((err: Error) => message.error(err.message));
  }, [message]);
  useEffect(load, [load]);

  const create = async () => {
    const v = await form.validateFields();
    try {
      const r = await api<{ key: string }>('/api/api-keys', { method: 'POST', body: { name: v.name, userId: v.userId, expiresOn: v.expiresOn ? v.expiresOn.format('YYYY-MM-DD') : null } });
      setCreating(false);
      form.resetFields();
      setSecret(r.key);
      load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const revoke = async (id: string) => {
    try {
      await api(`/api/api-keys/${id}/revoke`, { method: 'POST' });
      message.success(t('integrations.revoked'));
      load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const state = (r: ApiKeyRow) => (r.revokedAt ? 'revoked' : r.expiresAt && new Date(r.expiresAt) <= new Date() ? 'expired' : !r.user.isActive ? 'userInactive' : 'active');
  return (
    <Card
      size="small"
      title={t('integrations.apiKeys')}
      style={{ marginBottom: 16 }}
      data-testid="api-keys"
      extra={
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)} data-testid="api-key-new">
          {t('integrations.newKey')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">{t('integrations.apiKeysHint')}</Typography.Paragraph>
      <Table<ApiKeyRow>
        rowKey="id"
        size="small"
        pagination={false}
        scroll={{ x: 'max-content' }}
        dataSource={rows}
        locale={{ emptyText: t('integrations.noKeys') }}
        columns={[
          { title: t('integrations.name'), dataIndex: 'name' },
          { title: t('integrations.prefix'), render: (_, r) => <Typography.Text code>{`${r.prefix}…`}</Typography.Text> },
          { title: t('integrations.actsAs'), render: (_, r) => `${r.user.name} · ${tEnum('role', r.user.role)}` },
          { title: t('integrations.expiresAt'), render: (_, r) => (r.expiresAt ? fmtDateTime(r.expiresAt) : t('integrations.never')) },
          { title: t('integrations.lastUsedAt'), render: (_, r) => fmtDateTime(r.lastUsedAt) || '—' },
          {
            title: t('integrations.status'),
            render: (_, r) => {
              const s = state(r);
              return <Tag color={s === 'active' ? 'green' : 'default'}>{t(`integrations.keyState.${s}`)}</Tag>;
            },
          },
          {
            title: t('common.actions'),
            render: (_, r) =>
              !r.revokedAt && (
                <Popconfirm title={t('integrations.confirmRevoke', { name: r.name })} onConfirm={() => void revoke(r.id)}>
                  <Button type="link" size="small" danger>
                    {t('integrations.revoke')}
                  </Button>
                </Popconfirm>
              ),
          },
        ]}
      />
      <Modal title={t('integrations.newKey')} open={creating} onOk={create} onCancel={() => setCreating(false)} okText={t('common.save')} cancelText={t('common.cancel')} forceRender>
        <Form form={form} name="api-key" layout="vertical">
          <Form.Item name="name" label={t('integrations.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('integrations.name') }) }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="userId" label={t('integrations.actsAs')} extra={t('integrations.actsAsHint')} rules={[{ required: true, message: t('common.required', { field: t('integrations.actsAs') }) }]}>
            <Select options={owners.map((u) => ({ value: u.id, label: u.name }))} />
          </Form.Item>
          <Form.Item name="expiresOn" label={t('integrations.expiresOn')} extra={t('integrations.expiresHint')}>
            <DatePicker />
          </Form.Item>
        </Form>
      </Modal>
      <SecretModal title={t('integrations.keyCreated')} value={secret} onClose={() => setSecret(null)} />
    </Card>
  );
}

/** Webhook 投递记录抽屉 / webhook deliveries drawer */
function DeliveriesDrawer({ hook, onClose }: { hook: WebhookRow | null; onClose: () => void }) {
  const { message } = App.useApp();
  const [data, setData] = useState<{ items: Delivery[]; total: number } | null>(null);
  const [page, setPage] = useState(1);
  const load = useCallback(() => {
    if (!hook) return;
    api<{ items: Delivery[]; total: number }>(`/api/webhooks/${hook.id}/deliveries?page=${page}&pageSize=10`)
      .then(setData)
      .catch((err: Error) => message.error(err.message));
  }, [hook, page, message]);
  useEffect(load, [load]);
  const retry = async (id: string) => {
    try {
      await api(`/api/webhook-deliveries/${id}/retry`, { method: 'POST' });
      message.success(t('integrations.retryQueued'));
      load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };
  return (
    <Drawer title={hook ? t('integrations.deliveriesOf', { name: hook.name }) : ''} size={820} open={hook !== null} onClose={onClose} destroyOnHidden>
      <Table<Delivery>
        rowKey="id"
        size="small"
        data-testid="webhook-deliveries"
        loading={!data}
        dataSource={data?.items ?? []}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('integrations.noDeliveries') }}
        pagination={{ current: page, pageSize: 10, total: data?.total ?? 0, onChange: setPage, hideOnSinglePage: true }}
        expandable={{ expandedRowRender: (r) => <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(r.payload, null, 2)}</pre> }}
        columns={[
          { title: t('integrations.time'), render: (_, r) => fmtDateTime(r.createdAt) },
          { title: t('integrations.event'), dataIndex: 'event' },
          { title: t('integrations.status'), render: (_, r) => <Tag color={DELIVERY_COLOR[r.status]}>{tEnum('deliveryStatus', r.status)}</Tag> },
          { title: t('integrations.attempts'), dataIndex: 'attempts', align: 'right' },
          { title: t('integrations.response'), render: (_, r) => r.lastStatusCode ?? r.lastError ?? '—' },
          { title: t('integrations.nextAttempt'), render: (_, r) => (r.status === 'PENDING' ? fmtDateTime(r.nextAttemptAt) : '—') },
          {
            title: t('common.actions'),
            render: (_, r) =>
              r.status === 'FAILED' && r.event !== 'ping' ? (
                <Button type="link" size="small" onClick={() => void retry(r.id)}>
                  {t('integrations.retry')}
                </Button>
              ) : null,
          },
        ]}
      />
    </Drawer>
  );
}

/** Webhook 卡片 / webhooks card */
function WebhooksCard() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<WebhookRow[]>([]);
  const [editing, setEditing] = useState<WebhookRow | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [viewing, setViewing] = useState<WebhookRow | null>(null);
  const [form] = Form.useForm<{ name: string; url: string; isActive: boolean }>();

  const load = useCallback(() => {
    api<{ items: WebhookRow[] }>('/api/webhooks')
      .then((r) => setRows(r.items))
      .catch((err: Error) => message.error(err.message));
  }, [message]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) message.success(ok);
      load();
    } catch (err) {
      const code = err instanceof ClientApiError ? err.details?.url?.[0] : undefined;
      message.error(code ? t(`integrations.urlError.${code}` as Parameters<typeof t>[0]) : (err as Error).message);
    }
  };

  const open = (r: WebhookRow | 'new') => {
    form.resetFields();
    form.setFieldsValue(r === 'new' ? { name: '', url: 'https://', isActive: true } : { name: r.name, url: r.url, isActive: r.isActive });
    setEditing(r);
  };
  const save = async () => {
    const v = await form.validateFields();
    await run(async () => {
      if (editing === 'new') {
        const r = await api<{ secret: string }>('/api/webhooks', { method: 'POST', body: v });
        setSecret(r.secret);
      } else await api(`/api/webhooks/${(editing as WebhookRow).id}`, { method: 'PATCH', body: v });
      setEditing(null);
    }, t('common.saved'));
  };
  const test = (r: WebhookRow) =>
    run(async () => {
      const res = await api<{ ok: boolean; statusCode: number | null; error: string | null }>(`/api/webhooks/${r.id}/test`, { method: 'POST' });
      if (res.ok) message.success(t('integrations.testOk', { code: res.statusCode ?? '' }));
      else message.error(t('integrations.testFailed', { reason: String(res.statusCode ?? res.error ?? '') }));
    });

  return (
    <Card
      size="small"
      title={t('integrations.webhooks')}
      data-testid="webhooks"
      extra={
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => open('new')} data-testid="webhook-new">
          {t('integrations.newWebhook')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">{t('integrations.webhooksHint')}</Typography.Paragraph>
      <Table<WebhookRow>
        rowKey="id"
        size="small"
        pagination={false}
        scroll={{ x: 'max-content' }}
        dataSource={rows}
        locale={{ emptyText: t('integrations.noWebhooks') }}
        columns={[
          { title: t('integrations.name'), dataIndex: 'name' },
          { title: t('integrations.url'), render: (_, r) => <Typography.Text style={{ maxWidth: 280 }} ellipsis={{ tooltip: r.url }}>{r.url}</Typography.Text> },
          {
            title: t('integrations.active'),
            render: (_, r) => <Switch size="small" checked={r.isActive} aria-label={`${t('integrations.active')} ${r.name}`} onChange={(v) => void run(() => api(`/api/webhooks/${r.id}`, { method: 'PATCH', body: { isActive: v } }))} />,
          },
          {
            title: t('integrations.deliveries'),
            render: (_, r) => (
              <Space size={4}>
                <Tag color="green">{r.deliveries.SUCCEEDED}</Tag>
                <Tag color="blue">{r.deliveries.PENDING}</Tag>
                <Tag color="red">{r.deliveries.FAILED}</Tag>
              </Space>
            ),
          },
          {
            title: t('common.actions'),
            render: (_, r) => (
              <Space size={0} wrap>
                <Button type="link" size="small" onClick={() => void test(r)}>
                  {t('integrations.test')}
                </Button>
                <Button type="link" size="small" onClick={() => setViewing(r)}>
                  {t('integrations.deliveries')}
                </Button>
                <Button type="link" size="small" onClick={() => open(r)}>
                  {t('common.edit')}
                </Button>
                <Popconfirm title={t('integrations.confirmRegenerate')} onConfirm={() => void run(async () => setSecret((await api<{ secret: string }>(`/api/webhooks/${r.id}/secret`, { method: 'POST' })).secret))}>
                  <Button type="link" size="small">
                    {t('integrations.regenerate')}
                  </Button>
                </Popconfirm>
                <Popconfirm title={t('integrations.confirmDeleteWebhook', { name: r.name })} onConfirm={() => void run(() => api(`/api/webhooks/${r.id}`, { method: 'DELETE' }), t('common.deleted'))}>
                  <Button type="link" size="small" danger>
                    {t('common.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal title={editing === 'new' ? t('integrations.newWebhook') : t('integrations.editWebhook')} open={editing !== null} onOk={save} onCancel={() => setEditing(null)} okText={t('common.save')} cancelText={t('common.cancel')} forceRender>
        <Form form={form} name="webhook" layout="vertical">
          <Form.Item name="name" label={t('integrations.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('integrations.name') }) }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="url" label={t('integrations.url')} extra={t('integrations.urlHint')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('integrations.url') }) }]}>
            <Input maxLength={500} />
          </Form.Item>
          <Form.Item name="isActive" label={t('integrations.active')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
      <SecretModal title={t('integrations.secretTitle')} value={secret} onClose={() => setSecret(null)} />
      <DeliveriesDrawer hook={viewing} onClose={() => setViewing(null)} />
    </Card>
  );
}

export default function IntegrationsPage() {
  return (
    <Card title={t('integrations.title')}>
      <ApiKeysCard />
      <WebhooksCard />
    </Card>
  );
}
