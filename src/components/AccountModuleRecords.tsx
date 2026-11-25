/**
 * 客户详情中的自定义模块记录（跨启用的模块，按当前用户可见范围），点击跳到记录详情。
 * Custom module records of an account (across active modules, within the user's visibility); clicking opens the record.
 */
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { App, Table } from 'antd';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

interface Row {
  id: string;
  name: string;
  updatedAt: string;
  owner: { name: string } | null;
  module: { id: string; name: string };
}

export function AccountModuleRecords({ accountId }: { accountId: string }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    api<{ items: Row[]; total: number }>(`/api/custom-records?accountId=${accountId}&pageSize=50`)
      .then((r) => {
        setRows(r.items);
        setTotal(r.total);
      })
      .catch((err: Error) => message.error(err.message));
  }, [accountId, message]);
  return (
    <Table<Row>
      rowKey="id"
      size="small"
      dataSource={rows}
      data-testid="account-module-records"
      pagination={false}
      locale={{ emptyText: t('modules.recordsEmpty') }}
      footer={total > rows.length ? () => t('common.total', { total }) : undefined}
      columns={[
        { title: t('modules.module'), render: (_, r) => r.module.name },
        { title: t('modules.recordName'), render: (_, r) => <Link href={`/modules?m=${r.module.id}&id=${r.id}`}>{r.name}</Link> },
        { title: t('common.owner'), render: (_, r) => r.owner?.name ?? t('common.unassigned') },
        { title: t('common.updatedAt'), render: (_, r) => fmtDateTime(r.updatedAt) },
      ]}
    />
  );
}
