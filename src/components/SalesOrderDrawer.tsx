/**
 * 销售订单：详情抽屉（基本信息、明细与合计、发货 / 交付 / 取消、修改、打印）与“由报价单生成订单”对话框。
 * Sales orders: detail drawer (info, lines and totals, ship / deliver / cancel, edit, print) and the
 * "create from quote" dialog.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, App, Button, DatePicker, Descriptions, Drawer, Form, Input, Modal, Popconfirm, Space, Tag, Typography } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import type { Quote, SalesOrder, SalesOrderStatus } from '@/lib/types';
import { usePermissions } from './AuthProvider';
import { QuoteLinesTable } from './QuoteDrawer';

/** 状态颜色 / Status colours */
export const ORDER_STATUS_COLOR: Record<SalesOrderStatus, string> = { CONFIRMED: 'blue', SHIPPED: 'gold', DELIVERED: 'green', CANCELLED: 'default' };

/** 允许的状态流转（与服务端一致，仅用于显示按钮）/ allowed transitions (mirrors the server; UI only) */
const NEXT: Record<SalesOrderStatus, SalesOrderStatus[]> = { CONFIRMED: ['SHIPPED', 'CANCELLED'], SHIPPED: ['DELIVERED', 'CANCELLED'], DELIVERED: [], CANCELLED: [] };

/** 终态 / final statuses */
const isFinal = (s: SalesOrderStatus) => s === 'DELIVERED' || s === 'CANCELLED';

/** 订单状态标签 / order status tag */
export function OrderStatusTag({ status }: { status: SalesOrderStatus }) {
  return <Tag color={ORDER_STATUS_COLOR[status]}>{tEnum('orderStatus', status)}</Tag>;
}

/**
 * 订单相关错误提示。
 * Messages for order errors.
 */
export function orderError(err: unknown): string {
  const d = err instanceof ClientApiError ? err.details : undefined;
  const code = d?.quoteId?.[0] ?? d?.status?.[0];
  if (code === 'has_order' || code === 'not_accepted' || code === 'final' || code === 'changed') return t(`orders.error.${code}` as MessageKey);
  return (err as Error).message;
}

interface OrderForm {
  subject?: string;
  expectedDelivery?: Dayjs | null;
  shippingAddress?: string | null;
  notes?: string | null;
}

/** 表单值转为请求体 / form values to the request body */
const toBody = (v: OrderForm) => ({
  subject: v.subject,
  expectedDelivery: v.expectedDelivery ? v.expectedDelivery.format('YYYY-MM-DD') : null,
  shippingAddress: v.shippingAddress ?? null,
  notes: v.notes ?? null,
});

/** 订单表单字段（生成与修改共用）/ order form fields (shared by create and edit) */
function OrderFields() {
  return (
    <>
      <Form.Item name="subject" label={t('orders.subject')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('orders.subject') }) }]}>
        <Input maxLength={200} />
      </Form.Item>
      <Form.Item name="expectedDelivery" label={t('orders.expectedDelivery')}>
        <DatePicker />
      </Form.Item>
      <Form.Item name="shippingAddress" label={t('orders.shippingAddress')}>
        <Input.TextArea rows={2} maxLength={500} />
      </Form.Item>
      <Form.Item name="notes" label={t('orders.notes')}>
        <Input.TextArea rows={2} maxLength={5000} />
      </Form.Item>
    </>
  );
}

/**
 * 由已接受的报价单生成订单（收货地址默认为客户地址）。
 * Create an order from an accepted quote (the shipping address defaults to the account address).
 */
export function CreateOrderModal({ quote, onClose, onCreated }: { quote: Quote | null; onClose: () => void; onCreated: (order: SalesOrder) => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<OrderForm>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (quote) form.setFieldsValue({ subject: quote.subject, expectedDelivery: null, shippingAddress: quote.deal.account.address ?? null, notes: null });
  }, [quote, form]);

  const submit = async () => {
    if (!quote) return;
    const v = await form.validateFields();
    setSaving(true);
    try {
      const order = await api<SalesOrder>('/api/sales-orders', { method: 'POST', body: { quoteId: quote.id, ...toBody(v) } });
      message.success(t('orders.created', { number: order.orderNumber }));
      onCreated(order);
    } catch (err) {
      message.error(orderError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('orders.create')} open={quote !== null} onOk={submit} confirmLoading={saving} onCancel={onClose} okText={t('orders.createOk')} forceRender zIndex={1200}>
      <Typography.Paragraph type="secondary">{t('orders.createHint')}</Typography.Paragraph>
      <Form form={form} name="order-create" layout="vertical">
        <OrderFields />
      </Form>
    </Modal>
  );
}

interface Props {
  /** 打开的订单 ID；null 表示关闭 / order to show; null closes the drawer */
  orderId: string | null;
  onClose: () => void;
  /** 订单变化后 / called after any change */
  onChanged: () => void;
}

export function SalesOrderDrawer({ orderId, onClose, onChanged }: Props) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const [order, setOrder] = useState<SalesOrder | null>(null);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [form] = Form.useForm<OrderForm>();
  const [cancelForm] = Form.useForm<{ reason?: string }>();

  const load = useCallback(async () => {
    if (!orderId) return;
    try {
      setOrder(await api<SalesOrder>(`/api/sales-orders/${orderId}`));
    } catch (err) {
      message.error((err as Error).message);
      onClose();
    }
  }, [orderId, message, onClose]);

  useEffect(() => {
    // 打开时加载详情 / load on open
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!orderId) setOrder(null);
    else void load();
  }, [orderId, load]);

  /** 执行修改类请求并刷新 / run a mutation and refresh */
  const run = async (fn: () => Promise<SalesOrder>, ok: string): Promise<boolean> => {
    try {
      setOrder(await fn());
      message.success(ok);
      onChanged();
      return true;
    } catch (err) {
      message.error(orderError(err));
      return false;
    }
  };

  const setStatus = (status: SalesOrderStatus, reason?: string) =>
    run(() => api<SalesOrder>(`/api/sales-orders/${order!.id}/status`, { method: 'POST', body: reason ? { status, reason } : { status } }), t('common.saved'));

  const editable = !!order && perm.canEdit(order.deal) && !isFinal(order.status);

  const openEdit = () => {
    if (!order) return;
    form.setFieldsValue({
      subject: order.subject,
      expectedDelivery: order.expectedDelivery ? dayjs(order.expectedDelivery.slice(0, 10)) : null,
      shippingAddress: order.shippingAddress,
      notes: order.notes,
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    const v = await form.validateFields();
    if (await run(() => api<SalesOrder>(`/api/sales-orders/${order!.id}`, { method: 'PATCH', body: toBody(v) }), t('common.saved'))) setEditing(false);
  };

  const confirmCancel = async () => {
    const v = await cancelForm.validateFields();
    if (await setStatus('CANCELLED', v.reason?.trim() || undefined)) setCancelling(false);
  };

  return (
    <Drawer title={order ? `${t('orders.detail')} · ${order.orderNumber}` : t('orders.detail')} size={760} open={orderId !== null} onClose={onClose} destroyOnHidden>
      {order && (
        <div data-testid="order-detail">
          <Space wrap style={{ marginBottom: 16 }}>
            <Link href={`/print/sales-order?id=${order.id}`} target="_blank" rel="noopener">
              <PrinterOutlined /> {t('orders.print')}
            </Link>
            {editable && <Button onClick={openEdit}>{t('common.edit')}</Button>}
            {editable &&
              NEXT[order.status]
                .filter((s) => s !== 'CANCELLED')
                .map((s) => (
                  <Popconfirm key={s} title={t('orders.confirmStatus', { status: tEnum('orderStatus', s) })} onConfirm={() => setStatus(s)}>
                    <Button type="primary">{t(`orders.action.${s}` as MessageKey)}</Button>
                  </Popconfirm>
                ))}
            {editable && (
              <Button
                danger
                onClick={() => {
                  cancelForm.resetFields();
                  setCancelling(true);
                }}
              >
                {t('orders.action.CANCELLED')}
              </Button>
            )}
          </Space>
          {isFinal(order.status) && <Alert type="info" showIcon title={t('orders.finalHint')} style={{ marginBottom: 12 }} />}
          <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
            <Descriptions.Item label={t('orders.number')}>{order.orderNumber}</Descriptions.Item>
            <Descriptions.Item label={t('orders.status')}>
              <OrderStatusTag status={order.status} />
            </Descriptions.Item>
            <Descriptions.Item label={t('orders.subject')} span={2}>
              {order.subject}
            </Descriptions.Item>
            <Descriptions.Item label={t('quotes.account')}>{order.deal.account.name}</Descriptions.Item>
            <Descriptions.Item label={t('quotes.deal')}>{order.deal.name}</Descriptions.Item>
            <Descriptions.Item label={t('orders.quote')}>
              <Link href={`/quotes?id=${order.quote.id}`}>{order.quote.quoteNumber}</Link>
            </Descriptions.Item>
            <Descriptions.Item label={t('orders.expectedDelivery')}>{fmtDate(order.expectedDelivery?.slice(0, 10))}</Descriptions.Item>
            <Descriptions.Item label={t('orders.shippingAddress')} span={2}>
              <span style={{ whiteSpace: 'pre-wrap' }}>{order.shippingAddress}</span>
            </Descriptions.Item>
            <Descriptions.Item label={t('quotes.createdBy')}>{order.createdBy?.name}</Descriptions.Item>
            <Descriptions.Item label={t('common.createdAt')}>{fmtDateTime(order.createdAt)}</Descriptions.Item>
            {order.shippedAt && <Descriptions.Item label={t('orders.shippedAt')}>{fmtDateTime(order.shippedAt)}</Descriptions.Item>}
            {order.deliveredAt && <Descriptions.Item label={t('orders.deliveredAt')}>{fmtDateTime(order.deliveredAt)}</Descriptions.Item>}
            {order.cancelledAt && <Descriptions.Item label={t('orders.cancelledAt')}>{fmtDateTime(order.cancelledAt)}</Descriptions.Item>}
            {order.cancelledAt && <Descriptions.Item label={t('orders.cancelReason')}>{order.cancelReason}</Descriptions.Item>}
            <Descriptions.Item label={t('orders.notes')} span={2}>
              <span style={{ whiteSpace: 'pre-wrap' }}>{order.notes}</span>
            </Descriptions.Item>
          </Descriptions>
          <Typography.Title level={5}>{t('quotes.lines')}</Typography.Title>
          <QuoteLinesTable quote={order} />
        </div>
      )}
      <Modal title={t('orders.edit')} open={editing} onOk={saveEdit} onCancel={() => setEditing(false)} okText={t('common.save')} forceRender zIndex={1200}>
        <Form form={form} name="order-edit" layout="vertical">
          <OrderFields />
        </Form>
      </Modal>
      <Modal
        title={t('orders.cancelTitle')}
        open={cancelling}
        onOk={confirmCancel}
        onCancel={() => setCancelling(false)}
        okText={t('orders.action.CANCELLED')}
        okButtonProps={{ danger: true }}
        forceRender
        zIndex={1200}
      >
        <Typography.Paragraph type="secondary">{t('orders.cancelHint')}</Typography.Paragraph>
        <Form form={cancelForm} name="order-cancel" layout="vertical">
          <Form.Item name="reason" label={t('orders.cancelReason')}>
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>
    </Drawer>
  );
}
