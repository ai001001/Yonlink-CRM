/**
 * 通用数据 Hook：分页列表、负责人列表。
 * Shared data hooks: paginated lists and owner list.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { App } from 'antd';
import { api, qs } from './api';

/** 分页响应 / Paginated response */
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 分页列表数据。
 * Paginated list data.
 * @param path API 路径 / API path
 * @param filters 筛选条件（变化时回到第一页）/ filters (resetting to page 1 on change)
 */
export function usePagedList<T>(path: string, filters: Record<string, string | undefined>) {
  const { message } = App.useApp();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [data, setData] = useState<PageResult<T>>({ items: [], total: 0, page: 1, pageSize: 20 });
  const [loading, setLoading] = useState(false);
  const filterKey = JSON.stringify(filters);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<PageResult<T>>(`${path}${qs({ ...JSON.parse(filterKey), page, pageSize })}`));
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path, filterKey, page, pageSize, message]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setPage(1), [filterKey]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  return {
    data,
    loading,
    reload,
    pagination: {
      current: page,
      pageSize,
      total: data.total,
      showSizeChanger: true,
      onChange: (p: number, s: number) => {
        setPage(p);
        setPageSize(s);
      },
    },
  };
}

/** 用户（负责人）/ User (owner) */
export interface UserOption {
  id: string;
  name: string;
  email: string;
}

/**
 * 本组织用户列表。
 * Users of the current organization.
 */
export function useOwners(): UserOption[] {
  const [users, setUsers] = useState<UserOption[]>([]);
  useEffect(() => {
    api<{ items: UserOption[] }>('/api/users')
      .then((r) => setUsers(r.items))
      .catch(() => setUsers([]));
  }, []);
  return users;
}

/**
 * 把服务端字段错误映射到 antd Form。
 * Map server field errors onto an antd Form.
 */
export function toFormErrors(details: Record<string, string[]> | undefined) {
  return Object.entries(details ?? {}).map(([name, errors]) => ({ name, errors }));
}

/**
 * 页面加载时若 URL 带 ?id=，打开对应记录详情（用于全局搜索跳转）。
 * Open a record's detail when the URL carries ?id= on load (used by global search links).
 * @param open 打开详情的回调 / callback that opens the detail
 */
export function useOpenFromUrl(open: (id: string) => void): void {
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const id = new URLSearchParams(window.location.search).get('id');
    if (id) open(id);
  }, [open]);
}
