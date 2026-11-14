/**
 * 站内通知的前端工具：文案、跳转地址、未读数变化事件。
 * Client helpers for in-app notifications: text, link targets and the unread-change event.
 */
'use client';

import { t, type MessageKey } from '@/i18n';
import { fmtDateTime } from './format';

/** 通知 / Notification */
export interface AppNotification {
  id: string;
  type: 'ASSIGNED' | 'ACTIVITY_DUE';
  title: string;
  dueAt: string | null;
  readAt: string | null;
  createdAt: string;
  leadId: string | null;
  accountId: string | null;
  dealId: string | null;
  activityId: string | null;
  actor: { id: string; name: string } | null;
}

/** 通知列表结果 / Notification list result */
export interface NotificationPage {
  items: AppNotification[];
  total: number;
  page: number;
  pageSize: number;
  unread: number;
}

/** 通知已读、删除后触发，铃铛据此刷新未读数 / fired after reads and deletes so the bell refreshes */
export const NOTIFICATIONS_CHANGED = 'yonlink:notifications-changed';
/** 在当前列表页打开记录详情 / open a record on the current list page */
export const OPEN_RECORD = 'yonlink:open-record';

/** 通知未读数可能已变化 / the unread count may have changed */
export function notifyChanged(): void {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
}

/**
 * 通知关联记录的列表页与记录 ID。
 * The list page and record id a notification points at.
 */
export function notificationTarget(n: AppNotification): { path: string; id: string; entity: 'lead' | 'account' | 'deal' | 'activity' } {
  if (n.leadId) return { path: '/leads', id: n.leadId, entity: 'lead' };
  if (n.accountId) return { path: '/accounts', id: n.accountId, entity: 'account' };
  if (n.dealId) return { path: '/deals', id: n.dealId, entity: 'deal' };
  return { path: '/activities', id: n.activityId ?? '', entity: 'activity' };
}

/**
 * 通知文案。
 * Notification text.
 * @param now 当前时间（判断即将到期或已到期）/ current time (due soon vs overdue)
 */
export function notificationText(n: AppNotification, now = Date.now()): string {
  if (n.type === 'ACTIVITY_DUE') {
    const time = fmtDateTime(n.dueAt);
    return t(n.dueAt && new Date(n.dueAt).getTime() < now ? 'notifications.overdue' : 'notifications.dueSoon', { title: n.title, time });
  }
  const entity = t(`notifications.entity.${notificationTarget(n).entity}` as MessageKey);
  return t('notifications.assigned', { actor: n.actor?.name ?? t('notifications.someone'), entity, title: n.title });
}

/** 通知关联记录的地址 / link to the notification's record */
export function notificationHref(n: AppNotification): string {
  const { path, id } = notificationTarget(n);
  return `${path}?id=${encodeURIComponent(id)}`;
}

/**
 * 跳转到通知关联的记录：已在目标列表页时直接打开详情，否则带 ?id= 跳转。
 * Go to the notification's record: open the detail directly when already on the list page, otherwise navigate
 * with ?id=.
 */
export function openNotificationTarget(n: AppNotification, pathname: string, push: (href: string) => void): void {
  const { path, id } = notificationTarget(n);
  if ((pathname.replace(/\/$/, '') || '/') === path) window.dispatchEvent(new CustomEvent(OPEN_RECORD, { detail: { path, id } }));
  else push(notificationHref(n));
}
