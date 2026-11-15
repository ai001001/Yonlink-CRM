/**
 * 市场活动选择框（线索、商机的表单与列表筛选共用）：列出未取消的活动，并保留当前已选的值。
 * Campaign picker shared by lead / deal forms and list filters: non-cancelled campaigns plus the current value.
 */
'use client';

import { useEffect, useState } from 'react';
import { Select } from 'antd';
import { t } from '@/i18n';
import { api, qs } from '@/lib/api';

interface Option {
  id: string;
  name: string;
  status: string;
}

interface Props {
  value?: string | null;
  onChange?: (value: string | null) => void;
  placeholder?: string;
  id?: string;
  style?: React.CSSProperties;
  'aria-label'?: string;
}

export function CampaignSelect({ value, onChange, placeholder, id, style, 'aria-label': ariaLabel }: Props) {
  const [options, setOptions] = useState<Option[]>([]);

  useEffect(() => {
    let alive = true;
    api<{ items: Option[] }>(`/api/campaigns/options${qs({ include: value ?? undefined })}`)
      .then((r) => alive && setOptions(r.items))
      .catch(() => alive && setOptions([]));
    return () => {
      alive = false;
    };
    // 只在打开时加载一次（已选值始终包含在内）/ load once on mount (the current value is always included)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Select
      id={id}
      aria-label={ariaLabel}
      allowClear
      showSearch={{ optionFilterProp: 'label' }}
      placeholder={placeholder ?? t('campaigns.source')}
      style={style}
      value={value ?? undefined}
      onChange={(v?: string) => onChange?.(v ?? null)}
      options={options.map((o) => ({ value: o.id, label: o.name }))}
    />
  );
}
