/**
 * 远程搜索选择器（客户/线索/商机），只显示本组织数据（服务端过滤）。
 * Remote-search select for accounts / leads / deals (server filters by organization).
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { Select } from 'antd';
import { api, qs } from '@/lib/api';
import type { Ref } from '@/lib/types';

interface Props {
  /** 资源路径，如 /api/accounts / resource path */
  resource: '/api/accounts' | '/api/leads' | '/api/deals';
  value?: string | null;
  onChange?: (value: string | null) => void;
  /** 当前值的显示名（编辑时）/ label for the current value when editing */
  initialLabel?: string;
  placeholder?: string;
  id?: string;
}

export function RecordSelect({ resource, value, onChange, initialLabel, placeholder, id }: Props) {
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const search = (q: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api<{ items: Ref[] }>(`${resource}${qs({ q, pageSize: 20 })}`);
        setOptions(res.items.map((r) => ({ value: r.id, label: r.name })));
      } catch {
        setOptions([]);
      } finally {
        setLoading(false);
      }
    }, 250);
  };

  useEffect(() => {
    search('');
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource]);

  const merged =
    value && initialLabel && !options.some((o) => o.value === value) ? [{ value, label: initialLabel }, ...options] : options;

  return (
    <Select
      id={id}
      showSearch={{ filterOption: false, onSearch: search }}
      allowClear
      loading={loading}
      value={value ?? undefined}
      onChange={(v) => onChange?.(v ?? null)}
      options={merged}
      placeholder={placeholder}
      notFoundContent={null}
    />
  );
}
