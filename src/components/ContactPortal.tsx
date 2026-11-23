/**
 * 联系人详情中的客户门户区：开通状态、开通/重新邀请/重设密码（显示一次性邀请链接）、停用（需 portal.manage）。
 * Customer portal section in a contact's detail: status, grant / re-invite / reset (shows the one-time invitation
 * link) and disable (portal.manage).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Input, Modal, Popconfirm, Space, Tag, Typography } from 'antd';
import { t } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { siteUrl } from '@/lib/portal-api';

interface PortalInfo {
  status: 'INVITED' | 'ACTIVE' | 'DISABLED';
  email: string;
  lastLoginAt: string | null;
  inviteExpiresAt: string | null;
}

export function ContactPortal({ contactId }: { contactId: string }) {
  const { message } = App.useApp();
  const [info, setInfo] = useState<PortalInfo | null | undefined>(undefined);
  const [link, setLink] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ portal: PortalInfo | null }>(`/api/contacts/${contactId}/portal`)
      .then((r) => setInfo(r.portal))
      .catch(() => setInfo(undefined));
  }, [contactId]);
  useEffect(load, [load]);
  if (info === undefined) return null;

  const fail = (err: unknown) => {
    const d = err instanceof ClientApiError ? err.details : undefined;
    message.error(d?.email?.[0] === 'required' ? t('portal.needEmail') : d?.portal?.[0] === 'disabled' ? t('portal.portalOff') : d?.email?.[0] === 'taken' ? t('portal.emailTaken') : (err as Error).message);
  };
  const invite = async () => {
    try {
      const r = await api<{ token: string; portal: PortalInfo }>(`/api/contacts/${contactId}/portal/invite`, { method: 'POST' });
      setInfo(r.portal);
      setLink(siteUrl('portal/accept', { token: r.token }));
    } catch (err) {
      fail(err);
    }
  };
  const disable = async () => {
    try {
      setInfo((await api<{ portal: PortalInfo }>(`/api/contacts/${contactId}/portal/disable`, { method: 'POST' })).portal);
    } catch (err) {
      fail(err);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link ?? '');
      message.success(t('portal.copied'));
    } catch {
      // 剪贴板不可用时由用户手动复制 / copy manually when the clipboard is unavailable
    }
  };

  return (
    <Card size="small" style={{ marginTop: 16 }} title={t('portal.contactTitle')} data-testid="contact-portal">
      <Space wrap>
        <Tag color={info?.status === 'ACTIVE' ? 'success' : info?.status === 'INVITED' ? 'processing' : 'default'}>{info ? t(`portal.status.${info.status}`) : t('portal.none')}</Tag>
        {info?.lastLoginAt && <Typography.Text type="secondary">{t('portal.lastLogin', { time: fmtDateTime(info.lastLoginAt) })}</Typography.Text>}
        {info?.status === 'INVITED' && info.inviteExpiresAt && <Typography.Text type="secondary">{t('portal.inviteExpires', { time: fmtDateTime(info.inviteExpiresAt) })}</Typography.Text>}
      </Space>
      <div style={{ marginTop: 8 }}>
        <Space wrap>
          <Button size="small" type="primary" onClick={() => void invite()} data-testid="portal-invite">
            {!info || info.status === 'DISABLED' ? t('portal.invite') : info.status === 'ACTIVE' ? t('portal.resetPassword') : t('portal.reinvite')}
          </Button>
          {info && info.status !== 'DISABLED' && (
            <Popconfirm title={t('portal.confirmDisable')} onConfirm={() => void disable()}>
              <Button size="small" danger>
                {t('portal.disable')}
              </Button>
            </Popconfirm>
          )}
        </Space>
      </div>
      <Modal title={t('portal.inviteTitle')} open={link !== null} onCancel={() => setLink(null)} footer={<Button onClick={() => setLink(null)}>{t('common.close')}</Button>} destroyOnHidden>
        <Typography.Paragraph type="secondary">{t('portal.inviteHint')}</Typography.Paragraph>
        <Space.Compact style={{ width: '100%' }}>
          <Input readOnly value={link ?? ''} data-testid="portal-invite-link" />
          <Button onClick={() => void copy()}>{t('portal.copy')}</Button>
        </Space.Compact>
      </Modal>
    </Card>
  );
}
