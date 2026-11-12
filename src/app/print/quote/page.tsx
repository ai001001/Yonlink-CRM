/**
 * 报价单打印页（无导航外壳，适合浏览器打印 / 另存为 PDF）。地址：/print/quote?id=…，需登录且对报价单可见。
 * Printable quote page (no app shell; for browser print / save as PDF). URL /print/quote?id=…; sign-in and
 * visibility of the quote are required (checked by the server).
 */
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Descriptions, Space, Spin, Typography } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import { useAuth } from '@/components/AuthProvider';
import { QuoteLinesTable, QuoteStatusTag } from '@/components/QuoteDrawer';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import type { Quote } from '@/lib/types';

export default function PrintQuotePage() {
  const { me, loading } = useAuth();
  const router = useRouter();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!me) {
      router.replace('/login');
      return;
    }
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFailed(true);
      return;
    }
    api<Quote>(`/api/quotes/${encodeURIComponent(id)}`)
      .then(setQuote)
      .catch(() => setFailed(true));
  }, [loading, me, router]);

  if (failed) return <Alert type="error" showIcon title={t('quotes.notFound')} style={{ margin: 24 }} />;
  if (!quote) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spin />
      </div>
    );
  }

  return (
    <div className="print-page" data-testid="quote-print">
      <Space className="no-print" style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>
          {t('quotes.print')}
        </Button>
        <QuoteStatusTag quote={quote} />
      </Space>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, marginBottom: 16 }}>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {quote.organization?.name}
          </Typography.Title>
          <Typography.Text type="secondary">{t('app.name')}</Typography.Text>
        </div>
        <div style={{ textAlign: 'right' }}>
          <Typography.Title level={2} style={{ margin: 0 }}>
            {t('quotes.printTitle')}
          </Typography.Title>
          <Typography.Text strong>{quote.quoteNumber}</Typography.Text>
        </div>
      </div>
      <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
        <Descriptions.Item label={t('quotes.to')}>{quote.deal.account.name}</Descriptions.Item>
        <Descriptions.Item label={t('quotes.date')}>{fmtDate(quote.sentAt ?? quote.createdAt)}</Descriptions.Item>
        <Descriptions.Item label={t('accounts.phone')}>{quote.deal.account.phone}</Descriptions.Item>
        <Descriptions.Item label={t('quotes.validUntil')}>{fmtDate(quote.validUntil?.slice(0, 10))}</Descriptions.Item>
        <Descriptions.Item label={t('accounts.address')}>{quote.deal.account.address}</Descriptions.Item>
        <Descriptions.Item label={t('quotes.contactPerson')}>{quote.deal.owner?.name ?? quote.createdBy?.name}</Descriptions.Item>
        <Descriptions.Item label={t('quotes.subject')} span={2}>
          {quote.subject}
        </Descriptions.Item>
      </Descriptions>
      <QuoteLinesTable quote={quote} size="middle" />
      {quote.terms && (
        <div style={{ marginTop: 24 }}>
          <Typography.Title level={5}>{t('quotes.terms')}</Typography.Title>
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{quote.terms}</Typography.Paragraph>
        </div>
      )}
    </div>
  );
}
