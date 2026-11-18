/**
 * 导出按钮：按当前筛选导出 CSV；报表可另外显示“下载 Excel”按钮（.xlsx）。仅有导出权限的角色可见。
 * Export button: exports CSV for the current filters; reports can also show a "Download Excel" button (.xlsx). Visible to
 * roles with the export permission only.
 */
'use client';

import { useState } from 'react';
import { App, Button, Space } from 'antd';
import { DownloadOutlined, FileExcelOutlined } from '@ant-design/icons';
import { getLocale, t } from '@/i18n';
import { apiDownload, qs } from '@/lib/api';
import { usePermissions } from './AuthProvider';

interface Props {
  resource: 'leads' | 'accounts' | 'contacts' | 'deals' | 'activities' | 'tickets' | 'reports/receivables' | 'reports/sales' | 'forecasts';
  /** 下载文件名前缀（默认为 resource）/ download file name prefix (defaults to the resource) */
  fileName?: string;
  /** 当前筛选条件 / current filters */
  filters: Record<string, string | undefined>;
  /** 同时提供 Excel（.xlsx）下载 / also offer an Excel (.xlsx) download */
  excel?: boolean;
}

export function ExportButton({ resource, filters, fileName, excel }: Props) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const [busy, setBusy] = useState<'csv' | 'xlsx' | null>(null);
  if (!perm.can('data.export')) return null;

  const run = async (format: 'csv' | 'xlsx') => {
    setBusy(format);
    try {
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const params = { ...filters, lang: getLocale(), ...(format === 'xlsx' ? { format } : {}) };
      const headers = await apiDownload(`/api/${resource}/export${qs(params)}`, `${fileName ?? resource}-${stamp}.${format}`);
      const n = Number(headers.get('X-Export-Count') ?? 0);
      if (headers.get('X-Export-Truncated') === 'true') message.warning(t('export.truncated', { n }));
      else message.success(t('export.done', { n }));
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const csv = (
    <Button icon={<DownloadOutlined />} loading={busy === 'csv'} disabled={busy === 'xlsx'} onClick={() => run('csv')}>
      {t('export.button')}
    </Button>
  );
  if (!excel) return csv;
  return (
    <Space>
      {csv}
      <Button icon={<FileExcelOutlined />} loading={busy === 'xlsx'} disabled={busy === 'csv'} onClick={() => run('xlsx')} data-testid="export-excel">
        {t('export.excel')}
      </Button>
    </Space>
  );
}
