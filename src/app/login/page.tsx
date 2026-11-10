/**
 * 登录页 / Sign-in page.
 */
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, App, Button, Card, Form, Input, Typography } from 'antd';
import { useAuth } from '@/components/AuthProvider';
import { t } from '@/i18n';
import { STATIC_PREVIEW } from '@/lib/api';

export default function LoginPage() {
  const { me, signIn } = useAuth();
  const router = useRouter();
  const { message } = App.useApp();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (me) router.replace('/');
  }, [me, router]);

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg,#0f2a5a,#1f5fbf)' }}>
      <Card style={{ width: 380 }}>
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
      </Card>
    </div>
  );
}
