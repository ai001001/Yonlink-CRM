/**
 * 登录页：邮箱密码登录；演示环境下列出演示账号，点击“登录”即可免密进入。
 * Sign-in page: email/password login; in demo environments demo accounts are listed for one-click login.
 */
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, App, Button, Card, Divider, Form, Input, Table, Tag, Typography } from 'antd';
import { useAuth } from '@/components/AuthProvider';
import { LanguageSwitch } from '@/components/LanguageSwitch';
import { t, tEnum } from '@/i18n';
import { api, STATIC_PREVIEW } from '@/lib/api';

/** 演示账号（不含密码）/ Demo account (no password) */
interface DemoAccount {
  id: string;
  name: string;
  email: string;
  role: string;
  organizationName: string;
}

const ROLE_COLOR: Record<string, string> = { ADMIN: 'red', MANAGER: 'purple', SALES: 'blue', READONLY: 'default' };

export default function LoginPage() {
  const { me, signIn, signInDemo } = useAuth();
  const router = useRouter();
  const { message } = App.useApp();
  const [submitting, setSubmitting] = useState(false);
  const [demo, setDemo] = useState<DemoAccount[]>([]);
  const [demoBusy, setDemoBusy] = useState<string | null>(null);
  // 挂载后再渲染内容：预渲染为默认语言，浏览器可能是英文，避免水合不一致 / render after mount (prerender uses the default locale)
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  useEffect(() => {
    if (me) router.replace('/');
  }, [me, router]);

  useEffect(() => {
    // 未开启演示登录时接口返回 404，列表不显示 / the endpoint is 404 when demo login is disabled
    if (STATIC_PREVIEW) return;
    api<{ items: DemoAccount[] }>('/api/auth/demo-accounts')
      .then((r) => setDemo(r.items))
      .catch(() => setDemo([]));
  }, []);

  const demoLogin = async (account: DemoAccount) => {
    setDemoBusy(account.id);
    try {
      await signInDemo(account.id);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setDemoBusy(null);
    }
  };

  const background = 'linear-gradient(135deg,#0f2a5a,#1f5fbf)';
  if (!mounted) return <div style={{ minHeight: '100vh', background }} />;

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '32px 16px', background, position: 'relative' }}>
      <div style={{ position: 'absolute', top: 16, right: 16 }}>
        <LanguageSwitch />
      </div>
      <Card style={{ width: demo.length ? 560 : 380, maxWidth: '100%' }}>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          {t('login.title')}
        </Typography.Title>
        <Typography.Paragraph type="secondary">{t('app.brand')}</Typography.Paragraph>
        {STATIC_PREVIEW && <Alert type="warning" showIcon title={t('app.noBackend')} style={{ marginBottom: 16 }} />}
        <Form
          layout="vertical"
          disabled={STATIC_PREVIEW}
          onFinish={async (v: { email: string; password: string }) => {
            setSubmitting(true);
            try {
              await signIn(v.email, v.password);
            } catch (err) {
              message.error((err as Error).message);
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <Form.Item name="email" label={t('login.email')} rules={[{ required: true, type: 'email', message: t('common.invalidEmail') }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label={t('login.password')} rules={[{ required: true, message: t('common.required', { field: t('login.password') }) }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting}>
            {t('login.submit')}
          </Button>
        </Form>

        {demo.length > 0 && (
          <div data-testid="demo-accounts">
            <Divider />
            <Typography.Text type="secondary">{t('demo.title')}</Typography.Text>
            <Table<DemoAccount>
              rowKey="id"
              size="small"
              pagination={false}
              style={{ marginTop: 8 }}
              dataSource={demo}
              columns={[
                {
                  title: t('users.role'),
                  dataIndex: 'role',
                  render: (v: string, r) => (
                    <>
                      <Tag color={ROLE_COLOR[v]}>{tEnum('role', v)}</Tag>
                      {r.name}
                    </>
                  ),
                },
                { title: t('users.email'), dataIndex: 'email', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
                {
                  title: '',
                  align: 'right',
                  render: (_, r) => (
                    <Button size="small" loading={demoBusy === r.id} onClick={() => demoLogin(r)} aria-label={`${t('demo.login')} ${r.name}`}>
                      {t('demo.login')}
                    </Button>
                  ),
                },
              ]}
            />
            <Alert type="info" style={{ marginTop: 12 }} title={t('demo.notice')} />
          </div>
        )}
      </Card>
    </div>
  );
}
