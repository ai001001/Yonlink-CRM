/**
 * 导出按钮：按当前筛选导出 CSV（仅有导出权限的角色可见）。
 * Export button: exports CSV for the current filters (visible to roles with the export permission).
 */
'use client';

import { useState } from 'react';
import { App, Button } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { t } from '@/i18n';
import { apiDownload, qs } from '@/lib/api';
import { usePermissions } from './AuthProvider';

interface Props {
  resource: 'leads' | 'accounts' | 'deals' | 'activities';
  /** 当前筛选条件 / current filters */
  filters: Record<string, string | undefined>;
}

export function ExportButton({ resource, filters }: Props) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const [busy, setBusy] = useState(false);
  if (!perm.can('data.export')) return null;

  const run = async () => {
    setBusy(true);
    try {
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const headers = await apiDownload(`/api/${resource}/export${qs(filters)}`, `${resource}-${stamp}.csv`);
      const n = Number(headers.get('X-Export-Count') ?? 0);
      if (headers.get('X-Export-Truncated') === 'true') message.warning(t('export.truncated', { n }));
      else message.success(t('export.done', { n }));
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button icon={<DownloadOutlined />} loading={busy} onClick={run}>
      {t('export.button')}
    </Button>
  );
}
