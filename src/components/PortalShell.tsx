/**
 * 客户门户页面外框：读取门户首页信息（未登录或会话失效时回到登录页）、显示客户与组织、修改密码、退出。
 * Customer portal frame: loads the portal home info (back to sign-in when not signed in or expired), shows the
 * customer and organization, changes the password and signs out.
 */
'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { App, Button, Card, Form, Input, Layout, Modal, Space, Spin, Typography } from 'antd';
import { LanguageSwitch } from '@/components/LanguageSwitch';
import { t } from '@/i18n';
import { ClientApiError } from '@/lib/api';
import { getPortalKey, getPortalToken, portalApi, setPortalToken, siteUrl } from '@/lib/portal-api';

/** 门户首页信息 / portal home info */
export interface PortalMe {
  name: string;
  email: string;
  account: string;
  organization: string;
  welcome: string | null;
}
const MeContext = createContext<PortalMe | null>(null);
/** 当前门户用户 / the current portal user */
export const usePortalMe = () => useContext(MeContext);

/** 回到登录页 / go back to sign-in */
export function toPortalLogin() {
  const key = getPortalKey();
  window.location.href = siteUrl('portal/login', key ? { k: key } : {});
}

export function PortalShell({ children }: { children: ReactNode }) {
  const { message } = App.useApp();
  const [me, setMe] = useState<PortalMe | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [form] = Form.useForm<{ currentPassword: string; newPassword: string; confirm: string }>();

  useEffect(() => {
    if (!getPortalToken()) {
      toPortalLogin();
      return;
    }
    portalApi<PortalMe>('/api/portal/me')
      .then(setMe)
      .catch(() => toPortalLogin());
  }, []);

  const logout = useCallback(async () => {
    await portalApi('/api/portal/auth/logout', { method: 'POST' }).catch(() => undefined);
    setPortalToken(null);
    toPortalLogin();
  }, []);

  const changePassword = async () => {
    const v = await form.validateFields();
    try {
      await portalApi('/api/portal/auth/password', { method: 'POST', body: { currentPassword: v.currentPassword, newPassword: v.newPassword } });
      message.success(t('portal.passwordChanged'));
      setPwOpen(false);
    } catch (err) {
      if (err instanceof ClientApiError && err.details?.currentPassword) form.setFields([{ name: 'currentPassword', errors: [t('portal.wrongPassword')] }]);
      else message.error((err as Error).message);
    }
  };

  if (!me) return <Spin style={{ display: 'block', margin: '120px auto' }} />;
  return (
    <MeContext.Provider value={me}>
      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Header style={{ background: '#fff', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingInline: 16, flexWrap: 'wrap', height: 'auto', lineHeight: '48px' }}>
          <Space wrap>
            <Typography.Text strong>{me.organization}</Typography.Text>
            <Typography.Text type="secondary">{t('portal.brand')}</Typography.Text>
          </Space>
          <Space wrap data-testid="portal-user">
            <Typography.Text>{t('portal.hello', { name: me.name })}</Typography.Text>
            <Typography.Text type="secondary">{me.account}</Typography.Text>
            <Button size="small" onClick={() => (form.resetFields(), setPwOpen(true))}>
              {t('portal.changePassword')}
            </Button>
            <Button size="small" onClick={() => void logout()}>
              {t('portal.logout')}
            </Button>
            <LanguageSwitch />
          </Space>
        </Layout.Header>
        <Layout.Content style={{ padding: 16, maxWidth: 1100, width: '100%', margin: '0 auto' }}>
          {me.welcome && (
            <Card size="small" style={{ marginBottom: 16 }}>
              <Typography.Text>{me.welcome}</Typography.Text>
            </Card>
          )}
          {children}
        </Layout.Content>
      </Layout>
      <Modal title={t('portal.changePassword')} open={pwOpen} onOk={changePassword} onCancel={() => setPwOpen(false)} okText={t('common.save')} cancelText={t('common.cancel')} destroyOnHidden forceRender>
        <Form form={form} layout="vertical" name="portal-password">
          <Form.Item name="currentPassword" label={t('portal.currentPassword')} rules={[{ required: true, message: t('common.required', { field: t('portal.currentPassword') }) }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item name="newPassword" label={t('portal.newPassword')} rules={[{ required: true, min: 10, message: t('portal.passwordRule') }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label={t('portal.confirmPassword')}
            dependencies={['newPassword']}
            rules={[{ required: true, message: t('common.required', { field: t('portal.confirmPassword') }) }, ({ getFieldValue }) => ({ validator: (_, v) => (v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error(t('portal.passwordMismatch')))) })]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </MeContext.Provider>
  );
}
