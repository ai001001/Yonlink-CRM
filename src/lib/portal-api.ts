/**
 * 客户门户的浏览器端 API 客户端：使用独立的门户令牌（与员工登录互不影响），统一错误处理；以及门户页面地址。
 * Browser API client for the customer portal: a separate portal token (independent of staff sign-in) and unified
 * errors; plus portal page URLs.
 */
'use client';

import { API_BASE, ClientApiError } from './api';

const TOKEN_KEY = 'yonlink-portal.token';
const KEY_KEY = 'yonlink-portal.key';

/** 读写门户令牌 / read and write the portal token */
export function getPortalToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setPortalToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 存储不可用时忽略 / ignore when storage is unavailable
  }
}
/** 读写门户标识（退出后回到对应的登录页）/ read and write the portal key (to return to the right sign-in page) */
export function getPortalKey(): string | null {
  try {
    return localStorage.getItem(KEY_KEY);
  } catch {
    return null;
  }
}
export function setPortalKey(key: string): void {
  try {
    localStorage.setItem(KEY_KEY, key);
  } catch {
    // 忽略 / ignore
  }
}

/**
 * 调用门户 API；401 时清除门户令牌。
 * Call the portal API; a 401 clears the portal token.
 */
export async function portalApi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getPortalToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  } catch {
    throw new ClientApiError(0, 'NETWORK');
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: { code: string; details?: Record<string, string[]> } } | null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/portal/auth/')) setPortalToken(null);
    throw new ClientApiError(res.status, data?.error?.code ?? 'INTERNAL_ERROR', data?.error?.details);
  }
  return data as T;
}

/**
 * 本站某个页面的完整地址：部署路径前缀与末尾斜杠沿用当前地址（GitHub Pages 为 /Yonlink-CRM/…/）。
 * Full URL of a page on this site; the base path and trailing-slash style follow the current URL.
 * @param page 如 portal/login / e.g. portal/login
 */
export function siteUrl(page: string, query: Record<string, string> = {}): string {
  const { origin, pathname } = window.location;
  const base = pathname.replace(/\/(portal(\/[^/]+)?|[^/]+)\/?$/, '');
  const slash = pathname.endsWith('/') ? '/' : '';
  const qs = new URLSearchParams(query).toString();
  return `${origin}${base}/${page}${slash}${qs ? `?${qs}` : ''}`;
}
