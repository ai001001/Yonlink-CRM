/**
 * 顶部栏通知铃铛：显示未读数（每分钟、窗口重新可见时和通知变化后刷新），点开查看最新通知。
 * Header notification bell: unread badge (refreshed every minute, when the window becomes visible and after
 * changes); opens the latest notifications.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { App, Badge, Button, Empty, List, Popover, Space, Spin, Typography } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { NOTIFICATIONS_CHANGED, notificationHref, notificationText, notifyChanged, openNotificationTarget, type AppNotification, type NotificationPage } from '@/lib/notifications';

/** 未读数刷新间隔 / unread count refresh interval */
const POLL_MS = 60_000;
/** 弹出层显示的条数 / items shown in the popover */
const POPOVER_SIZE = 8;

export function NotificationBell() {
  const { message } = App.useApp();
  const router = useRouter();
  const pathname = usePathname();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[] | null>(null);

  const refreshCount = useCallback(async () => {
    try {
      setCount((await api<{ count: number }>('/api/notifications/unread-count')).count);
    } catch {
      // 轮询失败不打扰用户，下次再试 / polling failures are silent; retry next time
    }
  }, []);

  const loadItems = useCallback(async () => {
    try {
      const page = await api<NotificationPage>(`/api/notifications?pageSize=${POPOVER_SIZE}`);
      setItems(page.items);
      setCount(page.unread);
    } catch (err) {
      message.error((err as Error).message);
    }
  }, [message]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshCount();
    const timer = window.setInterval(() => void refreshCount(), POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && void refreshCount();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(NOTIFICATIONS_CHANGED, refreshCount);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(NOTIFICATIONS_CHANGED, refreshCount);
    };
  }, [refreshCount]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setItems(null);
      void loadItems();
    }
  };

  /** 点击通知：标为已读并跳转到记录 / click: mark read and go to the record */
  const onClick = async (n: AppNotification) => {
    setOpen(false);
    if (!n.readAt) {
      await api('/api/notifications/read', { method: 'POST', body: { ids: [n.id] } }).catch(() => undefined);
      notifyChanged();
    }
    openNotificationTarget(n, pathname, router.push);
  };

  const markAll = async () => {
    try {
      await api('/api/notifications/read', { method: 'POST', body: { all: true } });
      notifyChanged();
      await loadItems();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const content = (
    <div style={{ width: 360 }} data-testid="notification-popover">
      {items === null ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      ) : items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('notifications.empty')} />
      ) : (
        <List
          size="small"
          dataSource={items}
          style={{ maxHeight: 400, overflowY: 'auto' }}
          renderItem={(n) => (
            <List.Item style={{ paddingInline: 4 }} data-testid="notification-item">
              <Space orientation="vertical" size={0} style={{ width: '100%' }}>
                <Space size={6} align="start">
                  {!n.readAt && <Badge status="processing" />}
                  <Link
                    href={notificationHref(n)}
                    style={{ fontWeight: n.readAt ? 400 : 600 }}
                    onClick={(e) => {
                      e.preventDefault();
                      void onClick(n);
                    }}
                  >
                    {notificationText(n)}
                  </Link>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {fmtDateTime(n.createdAt)}
                </Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #f0f0f0', paddingTop: 8, marginTop: 4 }}>
        <Button size="small" type="link" disabled={count === 0} onClick={() => void markAll()}>
          {t('notifications.markAllRead')}
        </Button>
        <Link href="/notifications" onClick={() => setOpen(false)}>
          {t('notifications.viewAll')}
        </Link>
      </div>
    </div>
  );

  return (
    <Popover trigger="click" placement="bottomRight" open={open} onOpenChange={onOpenChange} title={t('notifications.title')} content={content}>
      <Badge count={count} size="small" overflowCount={99}>
        <Button type="text" shape="circle" icon={<BellOutlined style={{ fontSize: 18 }} />} aria-label={t('notifications.bell')} data-testid="notification-bell" />
      </Badge>
    </Popover>
  );
}
