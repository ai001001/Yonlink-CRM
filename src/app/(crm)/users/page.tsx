/**
 * 用户管理（仅系统管理员）：新增用户、修改角色、停用/启用、重置密码。
 * User management (admins only): create users, change roles, deactivate/activate, reset passwords.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useAuth, usePermissions } from '@/components/AuthProvider';
import { t, tEnum } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { toFormErrors } from '@/lib/hooks';

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'MANAGER' | 'SALES' | 'READONLY';
  isActive: boolean;
  isDemo: boolean;
  createdAt: string;
}

const ROLES = ['ADMIN', 'MANAGER', 'SALES', 'READONLY'] as const;
const roleOptions = ROLES.map((v) => ({ value: v, label: tEnum('role', v) }));
const ROLE_COLOR: Record<string, string> = { ADMIN: 'red', MANAGER: 'purple', SALES: 'blue', READONLY: 'default' };

/**
 * 把 409 冲突原因翻译为提示。
 * Translate 409 conflict reasons into messages.
 */
function conflictMessage(err: unknown): string {
  if (err instanceof ClientApiError && err.code === 'CONFLICT') {
    if (err.details?.user) return t('users.selfLocked');
    if (err.details?.role) return t('users.lastAdmin');
    return t('users.emailTaken');
  }
  return (err as Error).message;
}

export default function UsersPage() {
  const { me } = useAuth();
  const perm = usePermissions();
  const { message } = App.useApp();
  const [items, setItems] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [form] = Form.useForm();
  const [pwForm] = Form.useForm();

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: UserRow[] }>('/api/admin/users')).items);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (perm.can('user.manage')) void load();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      message.success(ok);
      void load();
      return true;
    } catch (err) {
      message.error(conflictMessage(err));
      return false;
    }
  };

  const save = async () => {
    const values = await form.validateFields();
    try {
      if (editing === 'new') await api('/api/admin/users', { method: 'POST', body: values });
      else await api(`/api/admin/users/${(editing as UserRow).id}`, { method: 'PATCH', body: { name: values.name, role: values.role } });
      message.success(t('common.saved'));
      setEditing(null);
      void load();
    } catch (err) {
      if (err instanceof ClientApiError) form.setFields(toFormErrors(err.details));
      message.error(conflictMessage(err));
    }
  };

  if (!perm.can('user.manage')) return <Alert type="warning" showIcon title={t('error.FORBIDDEN')} />;

  return (
    <Card
      title={t('users.title')}
      extra={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            form.resetFields();
            setEditing('new');
          }}
        >
          {t('users.new')}
        </Button>
      }
    >
      <Alert type="info" showIcon title={t('users.matrix')} description={t('users.matrixText')} style={{ marginBottom: 16 }} />
      <Table<UserRow>
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={false}
        columns={[
          {
            title: t('users.name'),
            dataIndex: 'name',
            render: (v: string, r) => (
              <Space>
                {v}
                {r.id === me?.id && t('users.you')}
                {r.isDemo && <Tag color="orange">{t('users.demo')}</Tag>}
              </Space>
            ),
          },
          { title: t('users.email'), dataIndex: 'email' },
          { title: t('users.role'), dataIndex: 'role', render: (v: string) => <Tag color={ROLE_COLOR[v]}>{tEnum('role', v)}</Tag> },
          {
            title: t('users.status'),
            dataIndex: 'isActive',
            render: (v: boolean) => (v ? <Tag color="green">{t('users.active')}</Tag> : <Tag>{t('users.inactive')}</Tag>),
          },
          { title: t('common.createdAt'), dataIndex: 'createdAt', render: fmtDateTime },
          {
            title: t('common.actions'),
            render: (_, r) => (
              <Space>
                <Button
                  type="link"
                  size="small"
                  onClick={() => {
                    form.resetFields();
                    form.setFieldsValue(r);
                    setEditing(r);
                  }}
                >
                  {t('common.edit')}
                </Button>
                <Button
                  type="link"
                  size="small"
                  onClick={() => {
                    pwForm.resetFields();
                    setResetting(r);
                  }}
                >
                  {t('users.resetPassword')}
                </Button>
                {r.id !== me?.id &&
                  (r.isActive ? (
                    <Popconfirm
                      title={t('users.confirmDeactivate')}
                      onConfirm={() => run(() => api(`/api/admin/users/${r.id}`, { method: 'PATCH', body: { isActive: false } }), t('common.saved'))}
                    >
                      <Button type="link" size="small" danger>
                        {t('users.deactivate')}
                      </Button>
                    </Popconfirm>
                  ) : (
                    <Button
                      type="link"
                      size="small"
                      onClick={() => run(() => api(`/api/admin/users/${r.id}`, { method: 'PATCH', body: { isActive: true } }), t('common.saved'))}
                    >
                      {t('users.activate')}
                    </Button>
                  ))}
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing === 'new' ? t('users.new') : t('users.edit')}
        open={editing !== null}
        onOk={save}
        onCancel={() => setEditing(null)}
        okText={t('common.save')}
        forceRender
      >
        <Form form={form} name="user" layout="vertical" initialValues={{ role: 'SALES' }}>
          <Form.Item name="name" label={t('users.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('users.name') }) }]}>
            <Input maxLength={100} />
          </Form.Item>
          {editing === 'new' && (
            <Form.Item name="email" label={t('users.email')} rules={[{ required: true, type: 'email', message: t('common.invalidEmail') }]}>
              <Input maxLength={254} autoComplete="off" />
            </Form.Item>
          )}
          <Form.Item
            name="role"
            label={t('users.role')}
            extra={editing !== 'new' && editing?.id === me?.id ? t('users.selfLocked') : undefined}
          >
            <Select options={roleOptions} disabled={editing !== 'new' && editing?.id === me?.id} />
          </Form.Item>
          {editing === 'new' && (
            <Form.Item name="password" label={t('users.password')} extra={t('users.passwordHint')} rules={[{ required: true, min: 10, max: 200, message: t('users.passwordHint') }]}>
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        title={`${t('users.resetPassword')} · ${resetting?.name ?? ''}`}
        open={resetting !== null}
        onCancel={() => setResetting(null)}
        okText={t('common.save')}
        onOk={async () => {
          const v = await pwForm.validateFields();
          if (await run(() => api(`/api/admin/users/${resetting!.id}/password`, { method: 'POST', body: v }), t('users.resetDone'))) setResetting(null);
        }}
        forceRender
      >
        <Form form={pwForm} name="reset" layout="vertical">
          <Form.Item name="password" label={t('users.newPassword')} extra={t('users.passwordHint')} rules={[{ required: true, min: 10, max: 200, message: t('users.passwordHint') }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
