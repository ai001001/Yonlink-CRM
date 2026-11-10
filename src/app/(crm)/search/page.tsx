/**
 * 全局搜索结果页（线索、客户、商机）。
 * Global search results page (leads, accounts, deals).
 */
'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { App, Card, Col, Empty, List, Row, Tag, Typography } from 'antd';
import { t, tEnum } from '@/i18n';
import { api, qs } from '@/lib/api';
import { fmtMoney } from '@/lib/format';

interface Results {
  leads: { id: string; name: string; company: string | null; status: string }[];
  accounts: { id: string; name: string; industry: string | null }[];
  deals: { id: string; name: string; stage: string; amount: string; currency: string; account: { name: string } }[];
}

function SearchResults() {
  const q = useSearchParams().get('q')?.trim() ?? '';
  const { message } = App.useApp();
  const [data, setData] = useState<Results | null>(null);

  useEffect(() => {
    if (!q) return;
    api<Results>(`/api/search${qs({ q })}`)
      .then(setData)
      .catch((err: Error) => message.error(err.message));
  }, [q, message]);

  const total = data ? data.leads.length + data.accounts.length + data.deals.length : 0;
  const href = (path: string, id: string) => `${path}?id=${encodeURIComponent(id)}`;

  return (
    <Card title={t('search.for', { q })} data-testid="search-results">
      {data && total === 0 && <Empty description={t('search.none')} />}
      {data && total > 0 && (
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={8}>
            <Typography.Title level={5}>{`${t('nav.leads')} (${data.leads.length})`}</Typography.Title>
            <List
              size="small"
              dataSource={data.leads}
              renderItem={(l) => (
                <List.Item>
                  <Link href={href('/leads', l.id)}>{l.name}</Link>
                  <span>
                    {l.company} <Tag>{tEnum('leadStatus', l.status)}</Tag>
                  </span>
                </List.Item>
              )}
            />
          </Col>
          <Col xs={24} lg={8}>
            <Typography.Title level={5}>{`${t('nav.accounts')} (${data.accounts.length})`}</Typography.Title>
            <List
              size="small"
              dataSource={data.accounts}
              renderItem={(a) => (
                <List.Item>
                  <Link href={href('/accounts', a.id)}>{a.name}</Link>
                  <span>{tEnum('industry', a.industry)}</span>
                </List.Item>
              )}
            />
          </Col>
          <Col xs={24} lg={8}>
            <Typography.Title level={5}>{`${t('nav.deals')} (${data.deals.length})`}</Typography.Title>
            <List
              size="small"
              dataSource={data.deals}
              renderItem={(d) => (
                <List.Item>
                  <Link href={href('/deals', d.id)}>{d.name}</Link>
                  <span>
                    {d.account.name} · {fmtMoney(d.amount, d.currency)}
                  </span>
                </List.Item>
              )}
            />
          </Col>
        </Row>
      )}
    </Card>
  );
}

export default function SearchPage() {
  return (
    <Suspense>
      <SearchResults />
    </Suspense>
  );
}
