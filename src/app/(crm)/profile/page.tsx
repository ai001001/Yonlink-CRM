/**
 * 个人设置页：账号信息与修改显示名称、修改密码（演示账号不可用）、登录设备与退出其他设备、最近登录记录。
 * Profile page: account details and renaming, password change (not for demo accounts), signed-in devices with
 * "sign out other devices", and recent sign-ins.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Col, Descriptions, Form, Input, Popconfirm, Row, Space, Spin, Table, Tag, Typography } from 'antd';
import { useAuth } from '@/components/AuthProvider';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

/** 个人信息 / profile payload */
interface Profile {
  user: { id: string; name: string; email: string; role: string; isDemo: boolean; createdAt: string; organization: { id: string; name: string } };
  sessions: { id: string; createdAt: string; expiresAt: string; current: boolean }[];
  loginHistory: { id: string; action: string; ip: string | null; userAgent: string | null; reason: string | null; createdAt: string }[];
}

/** 浏览器标识缩短显示 / shorten a user agent for display */
const shortAgent = (ua: string | null) => {
  if (!ua) return '';
  const m = /(Edg|Chrome|Firefox|Safari)\/[\d.]+/.exec(ua);
  return m ? m[0] : ua.slice(0, 40);
};

export default function ProfilePage() {
  const { message } = App.useApp();
  const { refresh } = useAuth();
  const [data, setData] = useState<Profile | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameForm] = Form.useForm<{ name: string }>();
  const [pwForm] = Form.useForm<{ currentPassword: string; newPassword: string; confirm: string }>();

  const load = useCallback(async () => {
    try {
      setData(await api<Profile>('/api/profile'));
    } catch (err) {
      message.error((err as Error).message);
    }
  }, [message]);

  useEffect(() => {
    // 打开页面时加载 / load on open
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const rename = async () => {
    const v = await nameForm.validateFields();
    try {
      setData(await api<Profile>('/api/profile', { method: 'PATCH', body: { name: v.name } }));
      message.success(t('profile.renamed'));
      setRenaming(false);
      void refresh();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const changePassword = async () => {
    const v = await pwForm.validateFields();
    setSaving(true);
    try {
      const r = await api<{ revokedSessions: number }>('/api/profile/password', { method: 'POST', body: { currentPassword: v.currentPassword, newPassword: v.newPassword } });
      message.success(t('profile.passwordChanged', { n: r.revokedSessions }));
      pwForm.resetFields();
      void load();
    } catch (err) {
      const d = err instanceof ClientApiError ? err.details : undefined;
      const code = d?.currentPassword?.[0] ?? d?.newPassword?.[0];
      if (code === 'incorrect') pwForm.setFields([{ name: 'currentPassword', errors: [t('profile.error.incorrect')] }]);
      else if (code === 'same') pwForm.setFields([{ name: 'newPassword', errors: [t('profile.error.same')] }]);
      message.error(code && ['incorrect', 'same', 'demo'].includes(code) ? t(`profile.error.${code}` as MessageKey) : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const revokeOthers = async () => {
    try {
      const r = await api<{ revokedSessions: number }>('/api/profile/sessions/revoke-others', { method: 'POST' });
      message.success(t('profile.revoked', { n: r.revokedSessions }));
      void load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  if (!data) {
    return (
      <Card title={t('profile.title')}>
        <Spin />
      </Card>
    );
  }
  const u = data.user;

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }} data-testid="profile">
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title={t('profile.account')} style={{ height: '100%' }}>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label={t('profile.name')}>
                {renaming ? (
                  <Form form={nameForm} name="profile-name" layout="inline" onFinish={rename}>
                    <Form.Item name="name" rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('profile.name') }) }]}>
                      <Input maxLength={100} aria-label={t('profile.name')} />
                    </Form.Item>
                    <Button type="primary" htmlType="submit">
                      {t('common.save')}
                    </Button>
                    <Button type="link" onClick={() => setRenaming(false)}>
                      {t('common.cancel')}
                    </Button>
                  </Form>
                ) : (
                  <Space>
                    <span data-testid="profile-name">{u.name}</span>
                    <Button
                      type="link"
                      size="small"
                      onClick={() => {
                        nameForm.setFieldsValue({ name: u.name });
                        setRenaming(true);
                      }}
                    >
                      {t('profile.rename')}
                    </Button>
                  </Space>
                )}
              </Descriptions.Item>
              <Descriptions.Item label={t('profile.email')}>{u.email}</Descriptions.Item>
              <Descriptions.Item label={t('profile.role')}>
                <Space>
                  <Tag color="blue">{tEnum('role', u.role)}</Tag>
                  {u.isDemo && <Tag color="orange">{t('demo.badge')}</Tag>}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('profile.organization')}>{u.organization.name}</Descriptions.Item>
              <Descriptions.Item label={t('profile.since')}>{fmtDateTime(u.createdAt)}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title={t('profile.password')} style={{ height: '100%' }}>
            {u.isDemo ? (
              <Alert type="info" showIcon title={t('profile.demoPassword')} />
            ) : (
              <Form form={pwForm} name="profile-password" layout="vertical" onFinish={changePassword}>
                <Typography.Paragraph type="secondary">{t('profile.passwordRule')}</Typography.Paragraph>
                <Form.Item name="currentPassword" label={t('profile.currentPassword')} rules={[{ required: true, message: t('common.required', { field: t('profile.currentPassword') }) }]}>
                  <Input.Password autoComplete="current-password" maxLength={200} />
                </Form.Item>
                <Form.Item
                  name="newPassword"
                  label={t('profile.newPassword')}
                  rules={[
                    { required: true, message: t('common.required', { field: t('profile.newPassword') }) },
                    { min: 10, message: t('profile.passwordRule') },
                  ]}
                >
                  <Input.Password autoComplete="new-password" maxLength={200} />
                </Form.Item>
                <Form.Item
                  name="confirm"
                  label={t('profile.confirmPassword')}
                  dependencies={['newPassword']}
                  rules={[
                    { required: true, message: t('common.required', { field: t('profile.confirmPassword') }) },
                    ({ getFieldValue }) => ({
                      validator: (_, v: string) => (!v || v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error(t('profile.passwordMismatch')))),
                    }),
                  ]}
                >
                  <Input.Password autoComplete="new-password" maxLength={200} />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={saving}>
                  {t('profile.password')}
                </Button>
              </Form>
            )}
          </Card>
        </Col>
      </Row>
      <Card
        title={t('profile.sessions')}
        extra={
          <Popconfirm title={t('profile.revokeConfirm')} onConfirm={revokeOthers} disabled={data.sessions.length <= 1}>
            <Button danger disabled={data.sessions.length <= 1}>
              {t('profile.revokeOthers')}
            </Button>
          </Popconfirm>
        }
      >
        <Typography.Paragraph type="secondary" data-testid="profile-sessions-hint">
          {t('profile.sessionsHint', { n: data.sessions.length })}
        </Typography.Paragraph>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={data.sessions}
          columns={[
            { title: t('profile.signedInAt'), dataIndex: 'createdAt', render: (v: string, r) => <Space>{fmtDateTime(v)}{r.current && <Tag color="green">{t('profile.current')}</Tag>}</Space> },
            { title: t('profile.expiresAt'), dataIndex: 'expiresAt', render: fmtDateTime },
          ]}
        />
      </Card>
      <Card title={t('profile.history')}>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={data.loginHistory}
          data-testid="profile-history"
          columns={[
            { title: t('profile.time'), dataIndex: 'createdAt', render: fmtDateTime },
            {
              title: t('profile.event'),
              render: (_, r) => (
                <Space size={4}>
                  <Tag color={r.action === 'auth.login_failed' ? 'red' : 'default'}>{tEnum('auditAction', r.action.split('.')[1])}</Tag>
                  {r.reason && <Typography.Text type="secondary">{tEnum('auditReason', r.reason)}</Typography.Text>}
                </Space>
              ),
            },
            { title: t('profile.ip'), dataIndex: 'ip' },
            { title: t('profile.client'), dataIndex: 'userAgent', render: shortAgent },
          ]}
        />
      </Card>
    </Space>
  );
}
