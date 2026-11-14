/**
 * 发票：详情抽屉（基本信息、明细与合计、收款记录、登记 / 撤销收款、作废、修改、打印）与“由订单生成发票”对话框。
 * Invoices: detail drawer (info, lines and totals, payments, record / revert payments, void, edit, print) and the
 * "create from order" dialog.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, App, Button, DatePicker, Descriptions, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import type { Invoice, InvoicePayment, InvoiceStatus, PaymentMethod, SalesOrder } from '@/lib/types';
import { usePermissions } from './AuthProvider';
import { QuoteLinesTable } from './QuoteDrawer';

/** 状态颜色 / Status colours */
export const INVOICE_STATUS_COLOR: Record<InvoiceStatus, string> = { UNPAID: 'blue', PARTIALLY_PAID: 'gold', PAID: 'green', VOID: 'default' };
/** 收款方式 / payment methods */
export const PAYMENT_METHODS: PaymentMethod[] = ['BANK_TRANSFER', 'CASH', 'CHECK', 'CARD', 'OTHER'];

/** 金额（分）/ amount in cents */
const cents = (v: string) => Math.round(Number(v) * 100);

/** 未付余额 / outstanding balance */
export const balanceOf = (inv: Pick<Invoice, 'total' | 'paidAmount'>) => ((cents(inv.total) - cents(inv.paidAmount)) / 100).toFixed(2);

/**
 * 是否逾期：未付清且到期日早于今天。
 * Overdue: not fully paid and due before today.
 */
export function isOverdue(inv: Pick<Invoice, 'status' | 'dueDate'>): boolean {
  return (inv.status === 'UNPAID' || inv.status === 'PARTIALLY_PAID') && dayjs(inv.dueDate.slice(0, 10)).isBefore(dayjs(), 'day');
}

/** 状态标签（含逾期提示）/ status tag with the overdue hint */
export function InvoiceStatusTag({ invoice }: { invoice: Pick<Invoice, 'status' | 'dueDate'> }) {
  return (
    <Space size={4}>
      <Tag color={INVOICE_STATUS_COLOR[invoice.status]}>{tEnum('invoiceStatus', invoice.status)}</Tag>
      {isOverdue(invoice) && <Tag color="red">{t('invoices.overdue')}</Tag>}
    </Space>
  );
}

/**
 * 发票相关错误提示。
 * Messages for invoice errors.
 */
export function invoiceError(err: unknown): string {
  const d = err instanceof ClientApiError ? err.details : undefined;
  const code = d?.salesOrderId?.[0] ?? d?.amount?.[0] ?? d?.dueDate?.[0] ?? d?.status?.[0];
  const known = ['has_invoice', 'cancelled', 'exceeds_balance', 'before_invoice_date', 'void', 'paid', 'has_payments'];
  if (code && known.includes(code)) return t(`invoices.error.${code}` as MessageKey);
  return (err as Error).message;
}

interface InvoiceForm {
  subject?: string;
  invoiceDate?: Dayjs;
  dueDate?: Dayjs;
  billingAddress?: string | null;
  notes?: string | null;
}

/** 表单值转为请求体 / form values to the request body */
const toBody = (v: InvoiceForm) => ({
  subject: v.subject,
  invoiceDate: v.invoiceDate?.format('YYYY-MM-DD'),
  dueDate: v.dueDate?.format('YYYY-MM-DD'),
  billingAddress: v.billingAddress ?? null,
  notes: v.notes ?? null,
});

/** 发票表单字段（生成与修改共用）/ invoice form fields (shared by create and edit) */
function InvoiceFields() {
  return (
    <>
      <Form.Item name="subject" label={t('invoices.subject')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('invoices.subject') }) }]}>
        <Input maxLength={200} />
      </Form.Item>
      <Space size="large">
        <Form.Item name="invoiceDate" label={t('invoices.invoiceDate')} rules={[{ required: true, message: t('common.required', { field: t('invoices.invoiceDate') }) }]}>
          <DatePicker allowClear={false} />
        </Form.Item>
        <Form.Item
          name="dueDate"
          label={t('invoices.dueDate')}
          dependencies={['invoiceDate']}
          rules={[
            { required: true, message: t('common.required', { field: t('invoices.dueDate') }) },
            ({ getFieldValue }) => ({
              validator: (_, v: Dayjs | undefined) =>
                !v || !getFieldValue('invoiceDate') || !v.isBefore(getFieldValue('invoiceDate'), 'day') ? Promise.resolve() : Promise.reject(new Error(t('invoices.error.before_invoice_date'))),
            }),
          ]}
        >
          <DatePicker allowClear={false} />
        </Form.Item>
      </Space>
      <Form.Item name="billingAddress" label={t('invoices.billingAddress')}>
        <Input.TextArea rows={2} maxLength={500} />
      </Form.Item>
      <Form.Item name="notes" label={t('invoices.notes')}>
        <Input.TextArea rows={2} maxLength={5000} />
      </Form.Item>
    </>
  );
}

/**
 * 由销售订单生成发票（开票地址默认为订单收货地址，到期日默认开票后 30 天）。
 * Create an invoice from a sales order (billing address defaults to the shipping address; due in 30 days).
 */
export function CreateInvoiceModal({ order, onClose, onCreated }: { order: SalesOrder | null; onClose: () => void; onCreated: (invoice: Invoice) => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<InvoiceForm>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (order) form.setFieldsValue({ subject: order.subject, invoiceDate: dayjs(), dueDate: dayjs().add(30, 'day'), billingAddress: order.shippingAddress, notes: null });
  }, [order, form]);

  const submit = async () => {
    if (!order) return;
    const v = await form.validateFields();
    setSaving(true);
    try {
      const invoice = await api<Invoice>('/api/invoices', { method: 'POST', body: { salesOrderId: order.id, ...toBody(v) } });
      message.success(t('invoices.created', { number: invoice.invoiceNumber }));
      onCreated(invoice);
    } catch (err) {
      message.error(invoiceError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('invoices.create')} open={order !== null} onOk={submit} confirmLoading={saving} onCancel={onClose} okText={t('invoices.createOk')} forceRender zIndex={1200}>
      <Typography.Paragraph type="secondary">{t('invoices.createHint')}</Typography.Paragraph>
      <Form form={form} name="invoice-create" layout="vertical">
        <InvoiceFields />
      </Form>
    </Modal>
  );
}

interface PaymentForm {
  amount?: string;
  paidOn?: Dayjs;
  method?: PaymentMethod;
  reference?: string;
}

interface Props {
  /** 打开的发票 ID；null 表示关闭 / invoice to show; null closes the drawer */
  invoiceId: string | null;
  onClose: () => void;
  /** 发票变化后 / called after any change */
  onChanged: () => void;
}

export function InvoiceDrawer({ invoiceId, onClose, onChanged }: Props) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [form] = Form.useForm<InvoiceForm>();
  const [payForm] = Form.useForm<PaymentForm>();
  const [voidForm] = Form.useForm<{ reason?: string }>();

  const load = useCallback(async () => {
    if (!invoiceId) return;
    try {
      setInvoice(await api<Invoice>(`/api/invoices/${invoiceId}`));
    } catch (err) {
      message.error((err as Error).message);
      onClose();
    }
  }, [invoiceId, message, onClose]);

  useEffect(() => {
    // 打开时加载详情 / load on open
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!invoiceId) setInvoice(null);
    else void load();
  }, [invoiceId, load]);

  /** 执行修改类请求并刷新 / run a mutation and refresh */
  const run = async (fn: () => Promise<Invoice>, ok: string): Promise<boolean> => {
    try {
      setInvoice(await fn());
      message.success(ok);
      onChanged();
      return true;
    } catch (err) {
      message.error(invoiceError(err));
      return false;
    }
  };

  const active = !!invoice && invoice.status !== 'VOID';
  const editable = active && perm.canEdit(invoice.deal);
  const canPay = editable && (invoice.status === 'UNPAID' || invoice.status === 'PARTIALLY_PAID');
  const canVoid = editable && Number(invoice.paidAmount) === 0;

  const openEdit = () => {
    if (!invoice) return;
    form.setFieldsValue({
      subject: invoice.subject,
      invoiceDate: dayjs(invoice.invoiceDate.slice(0, 10)),
      dueDate: dayjs(invoice.dueDate.slice(0, 10)),
      billingAddress: invoice.billingAddress,
      notes: invoice.notes,
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    const v = await form.validateFields();
    if (await run(() => api<Invoice>(`/api/invoices/${invoice!.id}`, { method: 'PATCH', body: toBody(v) }), t('common.saved'))) setEditing(false);
  };

  const openPay = () => {
    payForm.setFieldsValue({ amount: balanceOf(invoice!), paidOn: dayjs(), method: 'BANK_TRANSFER', reference: undefined });
    setPaying(true);
  };

  const savePay = async () => {
    const v = await payForm.validateFields();
    const body = { amount: String(v.amount), paidOn: v.paidOn!.format('YYYY-MM-DD'), method: v.method, reference: v.reference?.trim() || null };
    if (await run(() => api<Invoice>(`/api/invoices/${invoice!.id}/payments`, { method: 'POST', body }), t('invoices.paymentRecorded'))) setPaying(false);
  };

  const confirmVoid = async () => {
    const v = await voidForm.validateFields();
    const reason = v.reason?.trim();
    if (await run(() => api<Invoice>(`/api/invoices/${invoice!.id}/void`, { method: 'POST', body: reason ? { reason } : {} }), t('common.saved'))) setVoiding(false);
  };

  return (
    <Drawer title={invoice ? `${t('invoices.detail')} · ${invoice.invoiceNumber}` : t('invoices.detail')} size={780} open={invoiceId !== null} onClose={onClose} destroyOnHidden>
      {invoice && (
        <div data-testid="invoice-detail">
          <Space wrap style={{ marginBottom: 16 }}>
            <Link href={`/print/invoice?id=${invoice.id}`} target="_blank" rel="noopener">
              <PrinterOutlined /> {t('invoices.print')}
            </Link>
            {editable && <Button onClick={openEdit}>{t('common.edit')}</Button>}
            {canPay && (
              <Button type="primary" onClick={openPay}>
                {t('invoices.recordPayment')}
              </Button>
            )}
            {canVoid && (
              <Button
                danger
                onClick={() => {
                  voidForm.resetFields();
                  setVoiding(true);
                }}
              >
                {t('invoices.void')}
              </Button>
            )}
          </Space>
          {invoice.status === 'VOID' && <Alert type="info" showIcon title={t('invoices.voidHint')} style={{ marginBottom: 12 }} />}
          <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
            <Descriptions.Item label={t('invoices.number')}>{invoice.invoiceNumber}</Descriptions.Item>
            <Descriptions.Item label={t('invoices.status')}>
              <InvoiceStatusTag invoice={invoice} />
            </Descriptions.Item>
            <Descriptions.Item label={t('invoices.subject')} span={2}>
              {invoice.subject}
            </Descriptions.Item>
            <Descriptions.Item label={t('quotes.account')}>{invoice.deal.account.name}</Descriptions.Item>
            <Descriptions.Item label={t('invoices.order')}>
              <Link href={`/sales-orders?id=${invoice.salesOrder.id}`}>{invoice.salesOrder.orderNumber}</Link>
            </Descriptions.Item>
            <Descriptions.Item label={t('invoices.invoiceDate')}>{fmtDate(invoice.invoiceDate.slice(0, 10))}</Descriptions.Item>
            <Descriptions.Item label={t('invoices.dueDate')}>{fmtDate(invoice.dueDate.slice(0, 10))}</Descriptions.Item>
            <Descriptions.Item label={t('invoices.total')}>{fmtMoney(invoice.total, invoice.currency)}</Descriptions.Item>
            <Descriptions.Item label={t('invoices.paidAmount')}>
              <span data-testid="invoice-paid">{fmtMoney(invoice.paidAmount, invoice.currency)}</span>
            </Descriptions.Item>
            <Descriptions.Item label={t('invoices.balance')} span={2}>
              <Typography.Text strong data-testid="invoice-balance">
                {fmtMoney(balanceOf(invoice), invoice.currency)}
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label={t('invoices.billingAddress')} span={2}>
              <span style={{ whiteSpace: 'pre-wrap' }}>{invoice.billingAddress}</span>
            </Descriptions.Item>
            <Descriptions.Item label={t('quotes.createdBy')}>{invoice.createdBy?.name}</Descriptions.Item>
            <Descriptions.Item label={t('common.createdAt')}>{fmtDateTime(invoice.createdAt)}</Descriptions.Item>
            {invoice.paidAt && <Descriptions.Item label={t('invoices.paidAt')}>{fmtDateTime(invoice.paidAt)}</Descriptions.Item>}
            {invoice.voidedAt && <Descriptions.Item label={t('invoices.voidedAt')}>{fmtDateTime(invoice.voidedAt)}</Descriptions.Item>}
            {invoice.voidedAt && <Descriptions.Item label={t('invoices.voidReason')}>{invoice.voidReason}</Descriptions.Item>}
            <Descriptions.Item label={t('invoices.notes')} span={2}>
              <span style={{ whiteSpace: 'pre-wrap' }}>{invoice.notes}</span>
            </Descriptions.Item>
          </Descriptions>
          <Typography.Title level={5}>{t('invoices.payments')}</Typography.Title>
          <Table<InvoicePayment>
            rowKey="id"
            size="small"
            pagination={false}
            style={{ marginBottom: 16 }}
            dataSource={invoice.payments ?? []}
            locale={{ emptyText: t('invoices.noPayments') }}
            data-testid="invoice-payments"
            columns={[
              { title: t('invoices.paidOn'), dataIndex: 'paidOn', render: (v: string) => fmtDate(v.slice(0, 10)) },
              { title: t('invoices.amount'), dataIndex: 'amount', align: 'right', render: (v: string) => fmtMoney(v, invoice.currency) },
              { title: t('invoices.method'), dataIndex: 'method', render: (v: PaymentMethod) => tEnum('paymentMethod', v) },
              { title: t('invoices.reference'), dataIndex: 'reference' },
              { title: t('invoices.recordedBy'), render: (_, p) => p.recordedBy?.name },
              ...(editable
                ? [
                    {
                      title: t('common.actions'),
                      key: 'actions',
                      render: (_: unknown, p: InvoicePayment) => (
                        <Popconfirm
                          title={t('invoices.revertConfirm')}
                          onConfirm={() => run(() => api<Invoice>(`/api/invoices/${invoice.id}/payments/${p.id}`, { method: 'DELETE' }), t('invoices.paymentReverted'))}
                        >
                          <Button size="small" type="link" danger>
                            {t('invoices.revert')}
                          </Button>
                        </Popconfirm>
                      ),
                    },
                  ]
                : []),
            ]}
          />
          <Typography.Title level={5}>{t('quotes.lines')}</Typography.Title>
          <QuoteLinesTable quote={invoice} />
        </div>
      )}
      <Modal title={t('invoices.edit')} open={editing} onOk={saveEdit} onCancel={() => setEditing(false)} okText={t('common.save')} forceRender zIndex={1200}>
        <Form form={form} name="invoice-edit" layout="vertical">
          <InvoiceFields />
        </Form>
      </Modal>
      <Modal title={t('invoices.recordPayment')} open={paying} onOk={savePay} onCancel={() => setPaying(false)} okText={t('common.save')} forceRender zIndex={1200}>
        {invoice && <Typography.Paragraph type="secondary">{t('invoices.balanceHint', { amount: fmtMoney(balanceOf(invoice), invoice.currency) })}</Typography.Paragraph>}
        <Form form={payForm} name="invoice-payment" layout="vertical">
          <Space size="large" wrap>
            <Form.Item name="amount" label={t('invoices.amount')} rules={[{ required: true, message: t('common.required', { field: t('invoices.amount') }) }]}>
              <InputNumber<string> stringMode min="0.01" max={invoice ? balanceOf(invoice) : undefined} precision={2} style={{ width: 180 }} />
            </Form.Item>
            <Form.Item name="paidOn" label={t('invoices.paidOn')} rules={[{ required: true, message: t('common.required', { field: t('invoices.paidOn') }) }]}>
              <DatePicker allowClear={false} />
            </Form.Item>
            <Form.Item name="method" label={t('invoices.method')} rules={[{ required: true }]}>
              <Select style={{ width: 140 }} options={PAYMENT_METHODS.map((m) => ({ value: m, label: tEnum('paymentMethod', m) }))} />
            </Form.Item>
          </Space>
          <Form.Item name="reference" label={t('invoices.reference')}>
            <Input maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title={t('invoices.voidTitle')} open={voiding} onOk={confirmVoid} onCancel={() => setVoiding(false)} okText={t('invoices.void')} okButtonProps={{ danger: true }} forceRender zIndex={1200}>
        <Typography.Paragraph type="secondary">{t('invoices.voidConfirmHint')}</Typography.Paragraph>
        <Form form={voidForm} name="invoice-void" layout="vertical">
          <Form.Item name="reason" label={t('invoices.voidReason')}>
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>
    </Drawer>
  );
}
