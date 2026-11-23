/**
 * 客户门户设置页（设置 › 客户门户，需 portal.manage）：启用、欢迎语、门户登录地址与门户用户数量。
 * Customer portal settings (Setup › Customer portal, portal.manage): enable, welcome text, sign-in URL and user counts.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, Space, Switch, Typography } from 'antd';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { siteUrl } from '@/lib/portal-api';

interface Settings {
  isEnabled: boolean;
  portalKey: string | null;
  welcome: string | null;
  counts: { invited: number; active: number; disabled: number };
}

export default function PortalSettingsPage() {
  const { message } = App.useApp();
  const [data, setData] = useState<Settings | null>(null);
  const [welcome, setWelcome] = useState('');
  const load = useCallback(() => {
    api<Settings>('/api/portal-settings')
      .then((s) => {
        setData(s);
        setWelcome(s.welcome ?? '');
      })
      .catch((err: Error) => message.error(err.message));
  }, [message]);
  useEffect(load, [load]);

  const save = async (body: { isEnabled?: boolean; welcome?: string | null }) => {
    try {
      const s = await api<Settings>('/api/portal-settings', { method: 'PATCH', body });
      setData(s);
      setWelcome(s.welcome ?? '');
      message.success(t('common.saved'));
    } catch (err) {
      message.error((err as Error).message);
    }
  };
  const url = data?.portalKey ? siteUrl('portal/login', { k: data.portalKey }) : null;

  return (
    <Card title={t('portal.settingsTitle')}>
      <Typography.Paragraph type="secondary">{t('portal.settingsHint')}</Typography.Paragraph>
      {data && (
        <Form layout="vertical" style={{ maxWidth: 720 }}>
          <Form.Item label={t('portal.enabled')}>
            <Switch checked={data.isEnabled} aria-label={t('portal.enabled')} onChange={(v) => void save({ isEnabled: v })} />
          </Form.Item>
          <Form.Item label={t('portal.loginUrl')}>
            {url ? (
              <Space.Compact style={{ width: '100%' }}>
                <Input readOnly value={url} data-testid="portal-url" />
                <Button
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(url)
                      .then(() => message.success(t('portal.copied')))
                      .catch(() => undefined)
                  }
                >
                  {t('portal.copy')}
                </Button>
              </Space.Compact>
            ) : (
              <Typography.Text type="secondary">{t('portal.notEnabledYet')}</Typography.Text>
            )}
          </Form.Item>
          <Form.Item label={t('portal.welcome')}>
            <Input.TextArea rows={3} maxLength={500} value={welcome} onChange={(e) => setWelcome(e.target.value)} />
          </Form.Item>
          <Space>
            <Button type="primary" onClick={() => void save({ welcome: welcome.trim() || null })}>
              {t('common.save')}
            </Button>
            <Typography.Text type="secondary">{t('portal.counts', data.counts)}</Typography.Text>
          </Space>
        </Form>
      )}
    </Card>
  );
}
