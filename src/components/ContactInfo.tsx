/**
 * 咨询方式：侧栏底部（block）、顶部栏（pill）与登录页（card）三种样式，均可一键复制 QQ 号。
 * Contact details in three styles — sidebar footer (block), header (pill) and login page (card) — each copying the QQ number.
 */
'use client';

import { App, Button, Tooltip, Typography } from 'antd';
import { CopyOutlined, MessageOutlined } from '@ant-design/icons';
import { t } from '@/i18n';
import { CONTACT_QQ, contactName, copyText } from '@/lib/contact';

interface Props {
  variant: 'block' | 'pill' | 'card' | 'icon';
}

export function ContactInfo({ variant }: Props) {
  const { message } = App.useApp();
  const qq = CONTACT_QQ;
  const name = contactName();
  const copy = async () => {
    if (await copyText(qq)) message.success(t('contact.copied', { qq: qq }));
    else message.warning(t('contact.copyFailed', { qq: qq }));
  };
  const text = t('contact.qqLine', { qq: qq, name: name });

  if (variant === 'pill') {
    return (
      <Tooltip title={t('contact.clickToCopy')}>
        <button
          type="button"
          onClick={copy}
          data-testid="contact-pill"
          style={{ border: '1px solid #1f5fbf', color: '#1f5fbf', background: '#eef4fc', borderRadius: 999, padding: '2px 12px', cursor: 'pointer', whiteSpace: 'nowrap', fontSize: 13 }}
        >
          {t('contact.pill', { qq: qq, name: name })}
        </button>
      </Tooltip>
    );
  }
  if (variant === 'icon') {
    return (
      <Tooltip placement="right" title={`${text} · ${t('contact.clickToCopy')}`}>
        <Button type="text" icon={<MessageOutlined />} onClick={copy} aria-label={t('contact.copyQq')} data-testid="contact-icon" style={{ color: 'rgba(255,255,255,0.75)' }} />
      </Tooltip>
    );
  }
  if (variant === 'card') {
    return (
      <div data-testid="contact-card" style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#eef4fc', borderRadius: 8, padding: '10px 12px' }}>
        <MessageOutlined style={{ color: '#1f5fbf' }} />
        <Typography.Text style={{ flex: 1 }}>
          {t('contact.title')}
          {t('common.colon')}
          {text}
        </Typography.Text>
        <Button size="small" icon={<CopyOutlined />} onClick={copy}>
          {t('contact.copyQq')}
        </Button>
      </div>
    );
  }
  // 侧栏底部（深色背景）/ sidebar footer on the dark background
  return (
    <div data-testid="contact-block" style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12, padding: '10px 16px 14px', borderTop: '1px solid rgba(255,255,255,0.12)' }}>
      <div>{t('contact.title')}</div>
      <div style={{ color: '#fff', fontSize: 14, fontWeight: 600, margin: '2px 0' }}>QQ{t('common.colon')}{qq}</div>
      <div style={{ marginBottom: 6 }}>{name}</div>
      <Button size="small" block ghost icon={<CopyOutlined />} onClick={copy}>
        {t('contact.copyQq')}
      </Button>
    </div>
  );
}
