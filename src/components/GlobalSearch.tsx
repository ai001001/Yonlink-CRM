/**
 * 顶部全局搜索（Dashboard 阶段实现跨模块搜索，当前跳转到线索搜索）。
 * Header global search.
 */
'use client';

import { useRouter } from 'next/navigation';
import { Input } from 'antd';
import { t } from '@/i18n';

export function GlobalSearch() {
  const router = useRouter();
  return (
    <Input.Search
      allowClear
      placeholder={t('nav.searchPlaceholder')}
      style={{ maxWidth: 360 }}
      onSearch={(q) => q.trim() && router.push(`/search?q=${encodeURIComponent(q.trim())}`)}
    />
  );
}
