/**
 * 接受门户邀请页：/portal/accept?token=…；设置密码后自动登录并进入门户首页。
 * Accept a portal invitation: /portal/accept?token=…; set a password, then sign in and open the portal home.
 */
'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { LanguageSwitch } from '@/components/LanguageSwitch';
import { t } from '@/i18n';
import { ClientApiError } from '@/lib/api';
import { portalApi, setPortalKey, setPortalToken, siteUrl } from '@/lib/portal-api';

export default function PortalAcceptPage() {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    // 静态导出页面只能在加载后读取地址参数 / statically exported pages read URL parameters after loading
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(new URLSearchParams(window.location.search).get('token'));
  }, []);

  const submit = async (v: { password: string }) => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const r = await portalApi<{ token: string; portalKey: string }>('/api/portal/auth/accept', { method: 'POST', body: { token, password: v.password } });
      setPortalToken(r.token);
      setPortalKey(r.portalKey);
      window.location.href = siteUrl('portal');
    } catch (err) {
      setError(err instanceof ClientApiError && err.details?.token ? t('portal.inviteInvalid') : (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: '#f5f5f5' }}>
      <Card style={{ width: '100%', maxWidth: 420 }} title={t('portal.acceptTitle')} extra={<LanguageSwitch />}>
        <Typography.Paragraph type="secondary">{t('portal.acceptHintGeneric')}</Typography.Paragraph>
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} data-testid="portal-accept-error" />}
        <Form layout="vertical" name="portal-accept" onFinish={(v) => void submit(v)}>
          <Form.Item name="password" label={t('portal.newPassword')} rules={[{ required: true, min: 10, message: t('portal.passwordRule') }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label={t('portal.confirmPassword')}
            dependencies={['password']}
            rules={[{ required: true, message: t('common.required', { field: t('portal.confirmPassword') }) }, ({ getFieldValue }) => ({ validator: (_, v) => (v === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error(t('portal.passwordMismatch')))) })]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading} disabled={!token}>
            {t('portal.setPassword')}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
