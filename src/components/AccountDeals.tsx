/**
 * 客户详情中的商机列表。
 * Deals list shown inside the account detail.
 */
'use client';

import { useEffect, useState } from 'react';
import { Table, Tag } from 'antd';
import { t, tEnum } from '@/i18n';
import { api, qs } from '@/lib/api';
import { fmtDate, fmtMoney } from '@/lib/format';
import type { Deal } from '@/lib/types';

export function AccountDeals({ accountId }: { accountId: string }) {
  const [items, setItems] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ items: Deal[] }>(`/api/deals${qs({ accountId, pageSize: 100 })}`)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [accountId]);

  return (
    <Table<Deal>
      data-testid="account-deals"
      rowKey="id"
      size="small"
      loading={loading}
      pagination={false}
      dataSource={items}
      locale={{ emptyText: t('common.empty') }}
      columns={[
        { title: t('deals.name'), dataIndex: 'name' },
        { title: t('deals.amount'), dataIndex: 'amount', align: 'right', render: (v: string, r) => fmtMoney(v, r.currency) },
        { title: t('deals.stage'), dataIndex: 'stage', render: (v: string) => <Tag>{tEnum('dealStage', v)}</Tag> },
        { title: t('deals.expectedCloseDate'), dataIndex: 'expectedCloseDate', render: (v: string | null) => fmtDate(v?.slice(0, 10)) },
      ]}
    />
  );
}
