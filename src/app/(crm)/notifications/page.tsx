/**
 * 通知中心：我的全部通知，可按未读筛选、标为已读、删除、清除已读，点击跳转到关联记录。
 * Notification center: all my notifications, filter by unread, mark read, delete, clear read, click to open the
 * related record.
 */
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { App, Button, Card, Popconfirm, Segmented, Space, Table, Tag, Typography } from 'antd';
import { t, tEnum } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { usePagedList } from '@/lib/hooks';
import { NOTIFICATIONS_CHANGED, notificationHref, notificationText, notifyChanged, openNotificationTarget, type AppNotification } from '@/lib/notifications';

type Status = 'all' | 'unread';

const TYPE_COLOR: Record<AppNotification['type'], string> = { ASSIGNED: 'blue', ACTIVITY_DUE: 'orange' };

export default function NotificationsPage() {
  const { message } = App.useApp();
  const router = useRouter();
  const pathname = usePathname();
  const [status, setStatus] = useState<Status>('all');
  const { data, loading, reload, pagination } = usePagedList<AppNotification>('/api/notifications', { status });
  const unread = (data as typeof data & { unread?: number }).unread ?? 0;

  // 铃铛里的操作也会影响本页 / actions in the bell also affect this page
  useEffect(() => {
    window.addEventListener(NOTIFICATIONS_CHANGED, reload);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, reload);
  }, [reload]);

  const run = async (fn: () => Promise<unknown>, ok?: (r: never) => string) => {
    try {
      const r = await fn();
      if (ok) message.success(ok(r as never));
      notifyChanged();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const open = async (n: AppNotification) => {
    if (!n.readAt) await run(() => api('/api/notifications/read', { method: 'POST', body: { ids: [n.id] } }));
    openNotificationTarget(n, pathname, router.push);
  };

  return (
    <Card
      title={t('notifications.title')}
      extra={
        <Space>
          <Button disabled={unread === 0} onClick={() => void run(() => api('/api/notifications/read', { method: 'POST', body: { all: true } }))}>
            {t('notifications.markAllRead')}
          </Button>
          <Popconfirm
            title={t('notifications.clearReadConfirm')}
            onConfirm={() =>
              run(
                () => api<{ deleted: number }>('/api/notifications/clear-read', { method: 'POST' }),
                (r: { deleted: number }) => t('notifications.cleared', { n: r.deleted }),
              )
            }
          >
            <Button>{t('notifications.clearRead')}</Button>
          </Popconfirm>
        </Space>
      }
    >
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary">{t('notifications.hint')}</Typography.Text>
        <Space>
          <Segmented<Status>
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: t('notifications.all') },
              { value: 'unread', label: t('notifications.unread') },
            ]}
          />
          <Typography.Text type="secondary" data-testid="notification-unread">
            {t('notifications.unreadCount', { n: unread })}
          </Typography.Text>
        </Space>
        <Table<AppNotification>
          rowKey="id"
          loading={loading}
          dataSource={data.items}
          pagination={pagination}
          locale={{ emptyText: t('notifications.empty') }}
          columns={[
            {
              title: t('notifications.type'),
              dataIndex: 'type',
              width: 120,
              render: (v: AppNotification['type']) => <Tag color={TYPE_COLOR[v]}>{tEnum('notificationType', v)}</Tag>,
            },
            {
              title: t('notifications.bell'),
              key: 'text',
              render: (_, n) => (
                <Link
                  href={notificationHref(n)}
                  style={{ fontWeight: n.readAt ? 400 : 600 }}
                  onClick={(e) => {
                    e.preventDefault();
                    void open(n);
                  }}
                >
                  {notificationText(n)}
                </Link>
              ),
            },
            { title: t('common.createdAt'), dataIndex: 'createdAt', width: 170, render: fmtDateTime },
            {
              title: t('common.actions'),
              key: 'actions',
              width: 200,
              render: (_, n) => (
                <Space size={4}>
                  {!n.readAt && (
                    <Button size="small" type="link" onClick={() => void run(() => api('/api/notifications/read', { method: 'POST', body: { ids: [n.id] } }))}>
                      {t('notifications.markRead')}
                    </Button>
                  )}
                  <Button size="small" type="link" danger onClick={() => void run(() => api(`/api/notifications/${n.id}`, { method: 'DELETE' }))}>
                    {t('common.delete')}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Space>
    </Card>
  );
}
