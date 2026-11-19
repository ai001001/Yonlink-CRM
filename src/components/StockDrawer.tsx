/**
 * 产品库存抽屉：当前库存与再订货水平、手工调整（增减或盘点，需 product.manage）、库存流水（来源单据、变动后余额）。
 * Product stock drawer: current stock and reorder level, manual adjustment (add/subtract or count; product.manage) and
 * the movement history (source documents, balance after).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { App, Button, Descriptions, Drawer, Form, Input, InputNumber, Radio, Space, Table, Tag, Typography } from 'antd';
import { t, tEnum } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { Product } from '@/lib/types';

interface Movement {
  id: string;
  reason: 'ADJUSTMENT' | 'PURCHASE_RECEIPT' | 'SALES_SHIPMENT' | 'SALES_RETURN';
  quantity: string;
  balanceAfter: string;
  note: string | null;
  createdAt: string;
  actor: { id: string; name: string } | null;
  purchaseOrder: { id: string; poNumber: string } | null;
  salesOrder: { id: string; orderNumber: string } | null;
}

interface MovementPage {
  product: { id: string; sku: string; stockQuantity: string; reorderLevel: string | null; unit: string };
  items: Movement[];
  total: number;
}

/** 数量显示（去掉多余的 0，正数带 +）/ quantity display (no trailing zeros, + for positives) */
const qty = (v: string, signed = false) => {
  const n = Number(v);
  const s = String(n);
  return signed && n > 0 ? `+${s}` : s;
};

/**
 * 库存标签：缺货（≤ 0）红色、低库存橙色，否则显示数量。
 * Stock tag: out of stock (≤ 0) red, low stock orange, otherwise the quantity.
 */
export function StockTag({ product }: { product: Pick<Product, 'stockQuantity' | 'reorderLevel' | 'unit'> }) {
  const n = Number(product.stockQuantity);
  const low = product.reorderLevel !== null && n <= Number(product.reorderLevel);
  return (
    <Space size={4} data-testid="stock-quantity">
      <Typography.Text type={n <= 0 ? 'danger' : undefined}>{`${qty(product.stockQuantity)} ${product.unit}`}</Typography.Text>
      {n <= 0 ? <Tag color="red">{t('stock.out')}</Tag> : low ? <Tag color="orange">{t('stock.low')}</Tag> : null}
    </Space>
  );
}

export function StockDrawer({ product, canManage, onClose, onChanged }: { product: Product | null; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const { message } = App.useApp();
  const [data, setData] = useState<MovementPage | null>(null);
  const [page, setPage] = useState(1);
  const [form] = Form.useForm<{ mode: 'add' | 'set'; quantity: string; note: string }>();
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    if (!product) return;
    api<MovementPage>(`/api/products/${product.id}/stock?page=${page}&pageSize=10`)
      .then(setData)
      .catch((err: Error) => message.error(err.message));
  }, [product, page, message]);
  useEffect(load, [load]);

  const adjust = async () => {
    if (!product) return;
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api(`/api/products/${product.id}/stock`, { method: 'POST', body: { mode: v.mode, quantity: String(v.quantity), note: v.note } });
      message.success(t('stock.adjusted'));
      form.resetFields();
      setPage(1);
      load();
      onChanged();
    } catch (err) {
      message.error(err instanceof ClientApiError && err.details?.quantity?.[0] === 'no_change' ? t('stock.noChange') : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const current = data?.product;
  return (
    <Drawer title={product ? t('stock.title', { sku: product.sku }) : ''} size={760} open={product !== null} onClose={onClose} destroyOnHidden>
      {product && (
        <div data-testid="stock-drawer">
          <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
            <Descriptions.Item label={t('products.name')}>{product.name}</Descriptions.Item>
            <Descriptions.Item label={t('stock.quantity')}>{current ? <StockTag product={{ ...current }} /> : null}</Descriptions.Item>
            <Descriptions.Item label={t('stock.reorderLevel')}>{current?.reorderLevel !== null && current ? `${qty(current.reorderLevel!)} ${current.unit}` : t('stock.noReorder')}</Descriptions.Item>
          </Descriptions>
          {canManage && (
            <Form form={form} name="stock-adjust" layout="inline" initialValues={{ mode: 'add' }} style={{ marginBottom: 16, rowGap: 8 }}>
              <Form.Item name="mode">
                <Radio.Group
                  optionType="button"
                  options={[
                    { value: 'add', label: t('stock.modeAdd') },
                    { value: 'set', label: t('stock.modeSet') },
                  ]}
                />
              </Form.Item>
              <Form.Item name="quantity" rules={[{ required: true, message: t('common.required', { field: t('stock.adjustQuantity') }) }]}>
                <InputNumber<string> stringMode precision={2} style={{ width: 150 }} placeholder={t('stock.adjustQuantity')} aria-label={t('stock.adjustQuantity')} />
              </Form.Item>
              <Form.Item name="note" rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('stock.note') }) }]}>
                <Input maxLength={200} style={{ width: 240 }} placeholder={t('stock.note')} aria-label={t('stock.note')} />
              </Form.Item>
              <Button type="primary" loading={saving} onClick={adjust} data-testid="stock-adjust">
                {t('stock.adjust')}
              </Button>
            </Form>
          )}
          <Typography.Title level={5}>{t('stock.movements')}</Typography.Title>
          <Table<Movement>
            rowKey="id"
            size="small"
            dataSource={data?.items ?? []}
            loading={!data}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: t('stock.noMovements') }}
            pagination={{ current: page, pageSize: 10, total: data?.total ?? 0, onChange: setPage, hideOnSinglePage: true }}
            columns={[
              { title: t('stock.time'), render: (_, r) => fmtDateTime(r.createdAt) },
              { title: t('stock.reason'), render: (_, r) => tEnum('stockReason', r.reason) },
              { title: t('stock.change'), align: 'right', render: (_, r) => <Typography.Text type={Number(r.quantity) < 0 ? 'danger' : 'success'}>{qty(r.quantity, true)}</Typography.Text> },
              { title: t('stock.balance'), align: 'right', render: (_, r) => qty(r.balanceAfter) },
              {
                title: t('stock.source'),
                render: (_, r) =>
                  r.purchaseOrder ? (
                    <Link href={`/purchase-orders?id=${r.purchaseOrder.id}`}>{r.purchaseOrder.poNumber}</Link>
                  ) : r.salesOrder ? (
                    <Link href={`/sales-orders?id=${r.salesOrder.id}`}>{r.salesOrder.orderNumber}</Link>
                  ) : (
                    (r.note ?? '—')
                  ),
              },
              { title: t('stock.actor'), render: (_, r) => r.actor?.name ?? t('stageHistory.system') },
            ]}
          />
        </div>
      )}
    </Drawer>
  );
}
