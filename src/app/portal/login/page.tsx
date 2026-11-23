/**
 * 客户门户登录页（无需员工登录）：/portal/login?k=门户标识；邮箱 + 密码，成功后进入门户首页。
 * Customer portal sign-in (no staff session): /portal/login?k=portal key; email and password, then the portal home.
 */
'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { LanguageSwitch } from '@/components/LanguageSwitch';
import { t } from '@/i18n';
import { ClientApiError } from '@/lib/api';
import { getPortalKey, portalApi, setPortalKey, setPortalToken, siteUrl } from '@/lib/portal-api';

export default function PortalLoginPage() {
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    // 静态导出页面只能在加载后读取地址参数 / statically exported pages read URL parameters after loading
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKey(new URLSearchParams(window.location.search).get('k') ?? getPortalKey());
  }, []);

  const submit = async (v: { email: string; password: string }) => {
    if (!key) return;
    setLoading(true);
    setError(null);
    try {
      const r = await portalApi<{ token: string }>('/api/portal/auth/login', { method: 'POST', body: { portalKey: key, email: v.email, password: v.password } });
      setPortalToken(r.token);
      setPortalKey(key);
      window.location.href = siteUrl('portal');
    } catch (err) {
      setError(err instanceof ClientApiError && err.code === 'INVALID_CREDENTIALS' ? t('portal.loginFailed') : (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: '#f5f5f5' }}>
      <Card style={{ width: '100%', maxWidth: 420 }} title={t('portal.loginTitle')} extra={<LanguageSwitch />}>
        {key === null ? (
          <Alert type="warning" showIcon message={t('portal.missingKey')} />
        ) : (
          <>
            <Typography.Paragraph type="secondary">{t('portal.loginHint')}</Typography.Paragraph>
            {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} data-testid="portal-login-error" />}
            <Form layout="vertical" name="portal-login" onFinish={(v) => void submit(v)}>
              <Form.Item name="email" label={t('login.email')} rules={[{ required: true, type: 'email', message: t('common.required', { field: t('login.email') }) }]}>
                <Input autoComplete="email" />
              </Form.Item>
              <Form.Item name="password" label={t('login.password')} rules={[{ required: true, message: t('common.required', { field: t('login.password') }) }]}>
                <Input.Password autoComplete="current-password" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block loading={loading} disabled={!key}>
                {t('login.submit')}
              </Button>
            </Form>
          </>
        )}
      </Card>
    </div>
  );
}
