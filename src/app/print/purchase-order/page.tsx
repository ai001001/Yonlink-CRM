/**
 * 采购单打印页（无导航外壳，适合浏览器打印 / 另存为 PDF 发给供应商）。地址：/print/purchase-order?id=…，需登录且有 purchase.read。
 * Printable purchase order (no app shell; print or save as PDF for the vendor). URL /print/purchase-order?id=…;
 * sign-in and purchase.read are required (checked by the server).
 */
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Descriptions, Space, Spin, Typography } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import { useAuth } from '@/components/AuthProvider';
import { PoLinesTable, PoStatusTag, type PurchaseOrder } from '@/components/PurchaseOrderDrawer';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';

export default function PrintPurchaseOrderPage() {
  const { me, loading } = useAuth();
  const router = useRouter();
  const [po, setPo] = useState<PurchaseOrder | null>(null);
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
    api<PurchaseOrder>(`/api/purchase-orders/${encodeURIComponent(id)}`)
      .then(setPo)
      .catch(() => setFailed(true));
  }, [loading, me, router]);

  if (failed) return <Alert type="error" showIcon title={t('purchase.notFound')} style={{ margin: 24 }} />;
  if (!po) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spin />
      </div>
    );
  }

  return (
    <div className="print-page" data-testid="po-print">
      <Space className="no-print" style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>
          {t('purchase.print')}
        </Button>
        <PoStatusTag status={po.status} />
      </Space>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, marginBottom: 16 }}>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {t('purchase.printTitle')}
          </Typography.Title>
          <Typography.Text type="secondary">{po.organization?.name}</Typography.Text>
        </div>
        <Descriptions column={1} size="small" style={{ width: 320 }}>
          <Descriptions.Item label={t('purchase.number')}>{po.poNumber}</Descriptions.Item>
          <Descriptions.Item label={t('purchase.orderedAt')}>{fmtDate(po.orderedAt?.slice(0, 10))}</Descriptions.Item>
          <Descriptions.Item label={t('purchase.expectedDate')}>{fmtDate(po.expectedDate?.slice(0, 10))}</Descriptions.Item>
        </Descriptions>
      </div>
      <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
        <Descriptions.Item label={t('purchase.vendor')}>{po.vendor.name}</Descriptions.Item>
        <Descriptions.Item label={t('vendors.contactName')}>{[po.vendor.contactName, po.vendor.phone].filter(Boolean).join(' · ')}</Descriptions.Item>
        <Descriptions.Item label={t('vendors.paymentTerms')}>{po.vendor.paymentTerms}</Descriptions.Item>
        <Descriptions.Item label={t('purchase.currency')}>{po.currency}</Descriptions.Item>
        <Descriptions.Item label={t('purchase.subject')} span={2}>
          {po.subject}
        </Descriptions.Item>
        <Descriptions.Item label={t('purchase.deliveryAddress')} span={2}>
          {po.deliveryAddress}
        </Descriptions.Item>
      </Descriptions>
      <PoLinesTable po={po} />
      {po.notes && (
        <Typography.Paragraph style={{ marginTop: 16, whiteSpace: 'pre-wrap' }}>
          <Typography.Text strong>{t('common.description')}</Typography.Text>
          {t('common.colon')}
          {po.notes}
        </Typography.Paragraph>
      )}
    </div>
  );
}
