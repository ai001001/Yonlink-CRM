/**
 * 顶部全局搜索：跳转到跨线索/客户/商机的搜索结果页。
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
