/**
 * 销售订单打印页（无导航外壳，适合浏览器打印 / 另存为 PDF）。地址：/print/sales-order?id=…，需登录且对订单可见。
 * Printable sales order (no app shell; for browser print / save as PDF). URL /print/sales-order?id=…; sign-in and
 * visibility of the order are required (checked by the server).
 */
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Descriptions, Space, Spin, Typography } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import { useAuth } from '@/components/AuthProvider';
import { QuoteLinesTable } from '@/components/QuoteDrawer';
import { OrderStatusTag } from '@/components/SalesOrderDrawer';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import type { SalesOrder } from '@/lib/types';

export default function PrintSalesOrderPage() {
  const { me, loading } = useAuth();
  const router = useRouter();
  const [order, setOrder] = useState<SalesOrder | null>(null);
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
    api<SalesOrder>(`/api/sales-orders/${encodeURIComponent(id)}`)
      .then(setOrder)
      .catch(() => setFailed(true));
  }, [loading, me, router]);

  if (failed) return <Alert type="error" showIcon title={t('orders.notFound')} style={{ margin: 24 }} />;
  if (!order) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spin />
      </div>
    );
  }

  return (
    <div className="print-page" data-testid="order-print">
      <Space className="no-print" style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>
          {t('orders.print')}
        </Button>
        <OrderStatusTag status={order.status} />
      </Space>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, marginBottom: 16 }}>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {order.organization?.name}
          </Typography.Title>
          <Typography.Text type="secondary">{t('app.name')}</Typography.Text>
        </div>
        <div style={{ textAlign: 'right' }}>
          <Typography.Title level={2} style={{ margin: 0 }}>
            {t('orders.printTitle')}
          </Typography.Title>
          <Typography.Text strong>{order.orderNumber}</Typography.Text>
        </div>
      </div>
      <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
        <Descriptions.Item label={t('quotes.to')}>{order.deal.account.name}</Descriptions.Item>
        <Descriptions.Item label={t('quotes.date')}>{fmtDate(order.createdAt)}</Descriptions.Item>
        <Descriptions.Item label={t('accounts.phone')}>{order.deal.account.phone}</Descriptions.Item>
        <Descriptions.Item label={t('orders.expectedDelivery')}>{fmtDate(order.expectedDelivery?.slice(0, 10))}</Descriptions.Item>
        <Descriptions.Item label={t('orders.shippingAddress')}>{order.shippingAddress}</Descriptions.Item>
        <Descriptions.Item label={t('orders.quote')}>{order.quote.quoteNumber}</Descriptions.Item>
        <Descriptions.Item label={t('orders.subject')} span={2}>
          {order.subject}
        </Descriptions.Item>
      </Descriptions>
      <QuoteLinesTable quote={order} size="middle" />
      {order.notes && (
        <div style={{ marginTop: 24 }}>
          <Typography.Title level={5}>{t('orders.notes')}</Typography.Title>
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{order.notes}</Typography.Paragraph>
        </div>
      )}
    </div>
  );
}
