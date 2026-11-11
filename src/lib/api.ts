/**
 * 浏览器端 API 客户端：附带 Bearer 令牌，统一错误处理。
 * Browser API client: attaches the Bearer token and normalises errors.
 */
'use client';

import { t, type MessageKey } from '@/i18n';

const TOKEN_KEY = 'yonlink-crm.token';

/** 后端地址；为空表示同源 / Backend base URL; empty means same origin */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

/** 是否为未接入后端的静态预览 / Whether this is a static preview without a backend */
export const STATIC_PREVIEW = process.env.NEXT_PUBLIC_STATIC_PREVIEW === '1';

/**
 * 前端可展示的 API 错误。
 * API error presentable to the user.
 */
export class ClientApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details?: Record<string, string[]>,
  ) {
    super(t(`error.${code}` as MessageKey));
  }
}

/** 读取令牌 / Read the token */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** 保存或清除令牌 / Store or clear the token */
export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 存储不可用时忽略 / ignore when storage is unavailable
  }
}

/**
 * 调用后端 API。
 * Call the backend API.
 * @param path 以 /api 开头的路径 / path starting with /api
 * @param init fetch 选项；body 为对象时自动序列化 / fetch options; object bodies are JSON-encoded
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ClientApiError(0, 'NETWORK');
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: { code: string; details?: Record<string, string[]> } } | null;
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login') {
      setToken(null);
      window.dispatchEvent(new Event('yonlink:unauthorized'));
    }
    throw new ClientApiError(res.status, data?.error?.code ?? 'INTERNAL_ERROR', data?.error?.details);
  }
  return data as T;
}

/**
 * 构造查询字符串，忽略空值。
 * Build a query string, skipping empty values.
 */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') search.set(k, String(v));
  const s = search.toString();
  return s ? `?${s}` : '';
}

/**
 * 下载文件（携带 Bearer 令牌），触发浏览器保存，返回响应头供读取导出信息。
 * Download a file with the Bearer token, trigger a browser save, and return the headers.
 * @param path 以 /api 开头的路径 / path starting with /api
 * @param filename 保存的文件名 / file name to save as
 */
export async function apiDownload(path: string, filename: string): Promise<Headers> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ClientApiError(0, 'NETWORK');
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { code: string } } | null;
    throw new ClientApiError(res.status, data?.error?.code ?? 'INTERNAL_ERROR');
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return res.headers;
}
