/**
 * 发票打印页（无导航外壳，适合浏览器打印 / 另存为 PDF）。地址：/print/invoice?id=…，需登录且对发票可见。
 * Printable invoice (no app shell; for browser print / save as PDF). URL /print/invoice?id=…; sign-in and visibility
 * of the invoice are required (checked by the server).
 */
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Descriptions, Space, Spin, Typography } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import { useAuth } from '@/components/AuthProvider';
import { balanceOf, InvoiceStatusTag } from '@/components/InvoiceDrawer';
import { QuoteLinesTable } from '@/components/QuoteDrawer';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDate, fmtMoney } from '@/lib/format';
import type { Invoice } from '@/lib/types';

export default function PrintInvoicePage() {
  const { me, loading } = useAuth();
  const router = useRouter();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
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
    api<Invoice>(`/api/invoices/${encodeURIComponent(id)}`)
      .then(setInvoice)
      .catch(() => setFailed(true));
  }, [loading, me, router]);

  if (failed) return <Alert type="error" showIcon title={t('invoices.notFound')} style={{ margin: 24 }} />;
  if (!invoice) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spin />
      </div>
    );
  }

  return (
    <div className="print-page" data-testid="invoice-print">
      <Space className="no-print" style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>
          {t('invoices.print')}
        </Button>
        <InvoiceStatusTag invoice={invoice} />
      </Space>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, marginBottom: 16 }}>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {invoice.organization?.name}
          </Typography.Title>
          <Typography.Text type="secondary">{t('app.name')}</Typography.Text>
        </div>
        <div style={{ textAlign: 'right' }}>
          <Typography.Title level={2} style={{ margin: 0 }}>
            {t('invoices.printTitle')}
          </Typography.Title>
          <Typography.Text strong>{invoice.invoiceNumber}</Typography.Text>
        </div>
      </div>
      <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
        <Descriptions.Item label={t('quotes.to')}>{invoice.deal.account.name}</Descriptions.Item>
        <Descriptions.Item label={t('invoices.invoiceDate')}>{fmtDate(invoice.invoiceDate.slice(0, 10))}</Descriptions.Item>
        <Descriptions.Item label={t('invoices.billingAddress')}>{invoice.billingAddress}</Descriptions.Item>
        <Descriptions.Item label={t('invoices.dueDate')}>{fmtDate(invoice.dueDate.slice(0, 10))}</Descriptions.Item>
        <Descriptions.Item label={t('invoices.order')}>{invoice.salesOrder.orderNumber}</Descriptions.Item>
        <Descriptions.Item label={t('invoices.balance')}>{fmtMoney(balanceOf(invoice), invoice.currency)}</Descriptions.Item>
        <Descriptions.Item label={t('invoices.subject')} span={2}>
          {invoice.subject}
        </Descriptions.Item>
      </Descriptions>
      <QuoteLinesTable quote={invoice} size="middle" />
      {invoice.notes && (
        <div style={{ marginTop: 24 }}>
          <Typography.Title level={5}>{t('invoices.notes')}</Typography.Title>
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{invoice.notes}</Typography.Paragraph>
        </div>
      )}
    </div>
  );
}
