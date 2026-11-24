/**
 * 采购单组件：状态标签、新建 / 编辑表单（明细可选产品或手工填写）、详情抽屉（下单、收货、取消、删除、打印）。
 * Purchase order components: status tag, create / edit form (lines from products or typed in) and the detail drawer
 * (order, receive, cancel, delete, print).
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Alert, App, Button, DatePicker, Descriptions, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined, PrinterOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { t, tEnum } from '@/i18n';
import { api, ClientApiError, qs } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { usePermissions } from './AuthProvider';
import { useWarehouses, WarehouseSelect } from './Warehouses';

const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY'];
const STATUS_COLOR: Record<string, string> = { DRAFT: 'default', ORDERED: 'blue', PARTIALLY_RECEIVED: 'orange', RECEIVED: 'green', CANCELLED: 'red' };

/** 采购单明细 / Purchase order line */
export interface PoLine {
  id: string;
  position: number;
  productSku: string;
  productName: string;
  unit: string;
  quantity: string;
  receivedQuantity: string;
  unitCost: string;
  lineTotal: string;
}

/** 采购单 / Purchase order */
export interface PurchaseOrder {
  id: string;
  poNumber: string;
  subject: string;
  status: string;
  currency: string;
  taxPercent: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  exchangeRate: string | null;
  baseTotal: string | null;
  expectedDate: string | null;
  deliveryAddress: string | null;
  notes: string | null;
  cancelReason: string | null;
  orderedAt: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  vendorId: string;
  vendor: { id: string; name: string; contactName?: string | null; phone?: string | null; email?: string | null; address?: string | null; paymentTerms?: string | null };
  salesOrder: { id: string; orderNumber: string } | null;
  createdBy: { id: string; name: string } | null;
  organization?: { name: string };
  lines?: PoLine[];
}

/** 状态标签 / Status tag */
export function PoStatusTag({ status }: { status: string }) {
  return <Tag color={STATUS_COLOR[status]}>{tEnum('poStatus', status)}</Tag>;
}

/**
 * 采购单错误提示。
 * Messages for purchase order errors.
 */
export function poError(err: unknown): string {
  const d = err instanceof ClientApiError ? err.details : undefined;
  if (d?.lines?.some((x) => x.startsWith('zero_cost'))) return t('purchase.error.zeroCost', { lines: d.lines.map((x) => x.split(':')[1]).join(t('common.listSep')) });
  if (d?.lines?.some((x) => x.startsWith('over'))) return t('purchase.error.over');
  if (d?.status?.[0] === 'has_receipts') return t('purchase.error.hasReceipts');
  if (d?.vendorId?.[0] === 'inactive') return t('purchase.error.vendorInactive');
  if (d?.purchaseOrder?.[0] === 'stale') return t('purchase.error.stale');
  if (d?.salesOrderId?.[0] === 'cancelled') return t('purchase.error.soCancelled');
  return (err as Error).message;
}

interface LineForm {
  productId?: string;
  productSku?: string;
  productName?: string;
  unit?: string;
  quantity?: string;
  unitCost?: string;
}

interface PoForm {
  vendorId: string;
  subject: string;
  currency: string;
  taxPercent: string;
  expectedDate?: Dayjs | null;
  deliveryAddress?: string | null;
  notes?: string | null;
  lines: LineForm[];
}

interface FormProps {
  /** 编辑的采购单；'new' 为新建 / the order being edited, or 'new' */
  editing: PurchaseOrder | 'new' | null;
  /** 新建时预设的销售订单（以销定采）/ sales order preset for a new order */
  salesOrder?: { id: string; orderNumber: string } | null;
  onClose: () => void;
  onSaved: (po: PurchaseOrder) => void;
}

/**
 * 新建 / 编辑采购单表单。非草稿只能改主题、预计到货日、收货地址、备注。
 * Create / edit form. Non-drafts only change subject, expected date, address and notes.
 */
export function PurchaseOrderForm({ editing, salesOrder, onClose, onSaved }: FormProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm<PoForm>();
  const [vendors, setVendors] = useState<{ id: string; name: string; currency: string }[]>([]);
  const [products, setProducts] = useState<{ id: string; sku: string; name: string; unit: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const draft = editing === 'new' || editing?.status === 'DRAFT';
  // 由销售订单生成且未填明细时，服务端复制订单明细 / from a sales order without lines the server copies them
  const fromSo = editing === 'new' && !!salesOrder;

  useEffect(() => {
    if (!editing) return;
    api<{ items: { id: string; name: string; currency: string }[] }>(`/api/vendors${qs({ active: 'true', pageSize: 100 })}`)
      .then((r) => setVendors(r.items))
      .catch(() => setVendors([]));
    form.resetFields();
    if (editing === 'new') form.setFieldsValue({ currency: 'CNY', taxPercent: '0', lines: fromSo ? [] : [{ quantity: '1' }] });
    else
      form.setFieldsValue({
        ...editing,
        expectedDate: editing.expectedDate ? dayjs(editing.expectedDate.slice(0, 10)) : null,
        lines: (editing.lines ?? []).map((l) => ({ productSku: l.productSku, productName: l.productName, unit: l.unit, quantity: l.quantity, unitCost: l.unitCost })),
      });
  }, [editing, form, fromSo]);

  const searchProducts = (q: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        setProducts((await api<{ items: { id: string; sku: string; name: string; unit: string }[] }>(`/api/products${qs({ q, pageSize: 20 })}`)).items);
      } catch {
        setProducts([]);
      }
    }, 250);
  };

  const save = async () => {
    const v = await form.validateFields();
    const body: Record<string, unknown> = {
      subject: v.subject,
      expectedDate: v.expectedDate ? v.expectedDate.format('YYYY-MM-DD') : null,
      deliveryAddress: v.deliveryAddress ?? null,
      notes: v.notes ?? null,
    };
    if (draft) {
      Object.assign(body, { vendorId: v.vendorId, currency: v.currency, taxPercent: String(v.taxPercent ?? '0') });
      const lines = (v.lines ?? []).map((l) => ({
        ...(l.productId ? { productId: l.productId } : { productSku: l.productSku, productName: l.productName, unit: l.unit }),
        quantity: String(l.quantity),
        unitCost: String(l.unitCost ?? '0'),
      }));
      if (lines.length || !fromSo) body.lines = lines;
    }
    if (editing === 'new' && salesOrder) body.salesOrderId = salesOrder.id;
    setSaving(true);
    try {
      const po =
        editing === 'new'
          ? await api<PurchaseOrder>('/api/purchase-orders', { method: 'POST', body })
          : await api<PurchaseOrder>(`/api/purchase-orders/${(editing as PurchaseOrder).id}`, { method: 'PATCH', body });
      message.success(t('common.saved'));
      onSaved(po);
    } catch (err) {
      message.error(poError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={editing === 'new' ? t('purchase.new') : t('purchase.edit')} open={editing !== null} onOk={save} confirmLoading={saving} onCancel={onClose} okText={t('common.save')} width={980} forceRender zIndex={1100}>
      {fromSo && <Alert type="info" showIcon style={{ marginBottom: 12 }} title={t('purchase.fromSoHint', { number: salesOrder!.orderNumber })} />}
      {!draft && <Alert type="info" showIcon style={{ marginBottom: 12 }} title={t('purchase.lockedHint')} />}
      <Form form={form} name="purchase-order" layout="vertical">
        <div className="form-row">
          <Form.Item name="vendorId" label={t('purchase.vendor')} rules={[{ required: true, message: t('common.required', { field: t('purchase.vendor') }) }]}>
            <Select
              disabled={!draft}
              showSearch={{ optionFilterProp: 'label' }}
              options={vendors.map((x) => ({ value: x.id, label: x.name }))}
              onChange={(id: string) => {
                const vendor = vendors.find((x) => x.id === id);
                if (vendor && editing === 'new') form.setFieldValue('currency', vendor.currency);
              }}
            />
          </Form.Item>
          <Form.Item name="currency" label={t('purchase.currency')}>
            <Select disabled={!draft} options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
          </Form.Item>
          <Form.Item name="taxPercent" label={t('purchase.taxPercent')}>
            <InputNumber<string> disabled={!draft} stringMode min="0" max="100" precision={2} style={{ width: '100%' }} />
          </Form.Item>
        </div>
        <Form.Item name="subject" label={t('purchase.subject')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('purchase.subject') }) }]}>
          <Input maxLength={200} />
        </Form.Item>
        <div className="form-row">
          <Form.Item name="expectedDate" label={t('purchase.expectedDate')}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="deliveryAddress" label={t('purchase.deliveryAddress')}>
            <Input maxLength={500} />
          </Form.Item>
        </div>
        {draft && (
          <Form.List name="lines">
            {(rows, { add, remove }) => (
              <div data-testid="po-lines-editor" style={{ marginBottom: 12 }}>
                <Typography.Text strong>{t('purchase.lines')}</Typography.Text>
                {rows.map((row) => (
                  <Space key={row.key} align="start" wrap style={{ display: 'flex', marginTop: 8 }}>
                    <Form.Item name={[row.name, 'productId']} style={{ marginBottom: 0, width: 200 }}>
                      <Select
                        allowClear
                        aria-label={`${t('purchase.product')} ${row.name + 1}`}
                        placeholder={t('purchase.pickProduct')}
                        showSearch={{ filterOption: false, onSearch: searchProducts }}
                        onFocus={() => searchProducts('')}
                        options={products.map((p) => ({ value: p.id, label: `${p.sku} · ${p.name}` }))}
                        onChange={(id?: string) => {
                          const p = products.find((x) => x.id === id);
                          if (p) form.setFieldValue(['lines', row.name], { ...form.getFieldValue(['lines', row.name]), productSku: p.sku, productName: p.name, unit: p.unit });
                        }}
                        popupMatchSelectWidth={false}
                      />
                    </Form.Item>
                    <Form.Item name={[row.name, 'productSku']} rules={[{ required: true, message: t('purchase.sku') }]} style={{ marginBottom: 0, width: 110 }}>
                      <Input placeholder={t('purchase.sku')} aria-label={`${t('purchase.sku')} ${row.name + 1}`} maxLength={50} />
                    </Form.Item>
                    <Form.Item name={[row.name, 'productName']} rules={[{ required: true, message: t('purchase.productName') }]} style={{ marginBottom: 0, width: 170 }}>
                      <Input placeholder={t('purchase.productName')} aria-label={`${t('purchase.productName')} ${row.name + 1}`} maxLength={200} />
                    </Form.Item>
                    <Form.Item name={[row.name, 'unit']} rules={[{ required: true, message: t('purchase.unit') }]} style={{ marginBottom: 0, width: 70 }}>
                      <Input placeholder={t('purchase.unit')} aria-label={`${t('purchase.unit')} ${row.name + 1}`} maxLength={20} />
                    </Form.Item>
                    <Form.Item name={[row.name, 'quantity']} rules={[{ required: true, message: t('purchase.quantity') }]} style={{ marginBottom: 0, width: 100 }}>
                      <InputNumber<string> stringMode min="0.01" precision={2} placeholder={t('purchase.quantity')} aria-label={`${t('purchase.quantity')} ${row.name + 1}`} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item name={[row.name, 'unitCost']} rules={[{ required: true, message: t('purchase.unitCost') }]} style={{ marginBottom: 0, width: 130 }}>
                      <InputNumber<string> stringMode min="0" precision={2} placeholder={t('purchase.unitCost')} aria-label={`${t('purchase.unitCost')} ${row.name + 1}`} style={{ width: '100%' }} />
                    </Form.Item>
                    <Button type="text" danger icon={<DeleteOutlined />} aria-label={`${t('common.delete')} ${row.name + 1}`} onClick={() => remove(row.name)} />
                  </Space>
                ))}
                <Button type="dashed" icon={<PlusOutlined />} style={{ marginTop: 8 }} onClick={() => add({ quantity: '1' })}>
                  {t('purchase.addLine')}
                </Button>
              </div>
            )}
          </Form.List>
        )}
        <Form.Item name="notes" label={t('common.description')}>
          <Input.TextArea rows={2} maxLength={5000} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface DrawerProps {
  orderId: string | null;
  onClose: () => void;
  onChanged: () => void;
}

/**
 * 采购单详情抽屉。
 * Purchase order detail drawer.
 */
export function PurchaseOrderDrawer({ orderId, onClose, onChanged }: DrawerProps) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canManage = perm.can('purchase.manage');
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [editing, setEditing] = useState<PurchaseOrder | null>(null);
  const [receiving, setReceiving] = useState<Record<string, string> | null>(null);
  /** 收货仓库（多个启用仓库时可选，不选为默认仓库）/ receiving warehouse (optional with several active ones) */
  const [receiveWarehouse, setReceiveWarehouse] = useState<string>();
  const warehouses = useWarehouses();
  const [cancelReason, setCancelReason] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orderId) return;
    try {
      setPo(await api<PurchaseOrder>(`/api/purchase-orders/${orderId}`));
    } catch (err) {
      message.error((err as Error).message);
    }
  }, [orderId, message]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!orderId) setPo(null);
    else void load();
  }, [orderId, load]);

  const changed = (next: PurchaseOrder) => {
    setPo(next);
    onChanged();
  };

  const setStatus = async (status: 'ORDERED' | 'CANCELLED', reason?: string | null) => {
    if (!po) return false;
    try {
      changed(await api<PurchaseOrder>(`/api/purchase-orders/${po.id}/status`, { method: 'POST', body: { status, ...(reason ? { reason } : {}) } }));
      message.success(t('common.saved'));
      return true;
    } catch (err) {
      message.error(poError(err));
      return false;
    }
  };

  const receive = async () => {
    if (!po || !receiving) return;
    const lines = Object.entries(receiving)
      .filter(([, q]) => Number(q) > 0)
      .map(([lineId, quantity]) => ({ lineId, quantity: String(quantity) }));
    if (!lines.length) return;
    try {
      changed(await api<PurchaseOrder>(`/api/purchase-orders/${po.id}/receive`, { method: 'POST', body: { lines, ...(receiveWarehouse ? { warehouseId: receiveWarehouse } : {}) } }));
      message.success(t('purchase.received'));
      setReceiving(null);
    } catch (err) {
      message.error(poError(err));
    }
  };

  const remove = async () => {
    if (!po) return;
    try {
      await api(`/api/purchase-orders/${po.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      onChanged();
      onClose();
    } catch (err) {
      message.error(poError(err));
    }
  };

  const remaining = (l: PoLine) => (Number(l.quantity) - Number(l.receivedQuantity)).toFixed(2);
  const canReceive = po && ['ORDERED', 'PARTIALLY_RECEIVED'].includes(po.status);
  const canCancel = po && (po.status === 'DRAFT' || (po.status === 'ORDERED' && (po.lines ?? []).every((l) => Number(l.receivedQuantity) === 0)));

  return (
    <Drawer title={po ? `${t('purchase.detail')} · ${po.poNumber}` : t('purchase.detail')} size={900} open={orderId !== null} onClose={onClose}>
      {po && (
        <div data-testid="po-detail">
          <Space wrap style={{ marginBottom: 16 }} data-testid="po-actions">
            <Link href={`/print/purchase-order?id=${po.id}`} target="_blank">
              <Button icon={<PrinterOutlined />}>{t('purchase.print')}</Button>
            </Link>
            {canManage && !['RECEIVED', 'CANCELLED'].includes(po.status) && <Button onClick={() => setEditing(po)}>{t('common.edit')}</Button>}
            {canManage && po.status === 'DRAFT' && (
              <Popconfirm title={t('purchase.confirmOrder')} onConfirm={() => setStatus('ORDERED')}>
                <Button type="primary">{t('purchase.action.order')}</Button>
              </Popconfirm>
            )}
            {canManage && canReceive && (
              <Button type="primary" onClick={() => setReceiving(Object.fromEntries((po.lines ?? []).map((l) => [l.id, remaining(l)])))}>
                {t('purchase.action.receive')}
              </Button>
            )}
            {canManage && canCancel && <Button onClick={() => setCancelReason('')}>{t('purchase.action.cancel')}</Button>}
            {canManage && po.status === 'DRAFT' && (
              <Popconfirm title={t('common.confirmDelete')} onConfirm={remove}>
                <Button danger>{t('common.delete')}</Button>
              </Popconfirm>
            )}
          </Space>
          <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
            <Descriptions.Item label={t('purchase.subject')} span={2}>
              {po.subject}
            </Descriptions.Item>
            <Descriptions.Item label={t('purchase.status')}>
              <PoStatusTag status={po.status} />
            </Descriptions.Item>
            <Descriptions.Item label={t('purchase.vendor')}>
              <Link href={`/vendors?id=${po.vendor.id}`}>{po.vendor.name}</Link>
            </Descriptions.Item>
            <Descriptions.Item label={t('purchase.salesOrder')}>{po.salesOrder ? <Link href={`/sales-orders?id=${po.salesOrder.id}`}>{po.salesOrder.orderNumber}</Link> : null}</Descriptions.Item>
            <Descriptions.Item label={t('purchase.expectedDate')}>{fmtDate(po.expectedDate?.slice(0, 10))}</Descriptions.Item>
            <Descriptions.Item label={t('purchase.total')}>
              <span data-testid="po-total">{fmtMoney(po.total, po.currency)}</span>
            </Descriptions.Item>
            <Descriptions.Item label={t('purchase.rateSnapshot')}>
              {po.status === 'DRAFT' || po.status === 'CANCELLED'
                ? '—'
                : po.exchangeRate
                  ? t('purchase.rateLine', { currency: po.currency, rate: Number(po.exchangeRate).toString(), base: fmtMoney(po.baseTotal ?? '0', 'CNY') })
                  : t('purchase.rateMissing')}
            </Descriptions.Item>
            <Descriptions.Item label={t('purchase.orderedAt')}>{fmtDateTime(po.orderedAt)}</Descriptions.Item>
            <Descriptions.Item label={t('purchase.receivedAt')}>{fmtDateTime(po.receivedAt)}</Descriptions.Item>
            <Descriptions.Item label={t('purchase.deliveryAddress')} span={2}>
              {po.deliveryAddress}
            </Descriptions.Item>
            {po.cancelReason && (
              <Descriptions.Item label={t('purchase.cancelReason')} span={2}>
                {po.cancelReason}
              </Descriptions.Item>
            )}
            <Descriptions.Item label={t('common.description')} span={2}>
              <span style={{ whiteSpace: 'pre-wrap' }}>{po.notes}</span>
            </Descriptions.Item>
          </Descriptions>
          <PoLinesTable po={po} />
        </div>
      )}

      <PurchaseOrderForm
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={(next) => {
          setEditing(null);
          changed(next);
        }}
      />

      <Modal title={t('purchase.action.receive')} open={receiving !== null} onOk={receive} onCancel={() => setReceiving(null)} okText={t('purchase.confirmReceive')} width={720} zIndex={1100}>
        <Typography.Paragraph type="secondary">{t('purchase.receiveHint')}</Typography.Paragraph>
        {warehouses.items.filter((w) => w.isActive).length > 1 && (
          <Space style={{ marginBottom: 12 }}>
            <Typography.Text>{t('stock.receiveWarehouse')}</Typography.Text>
            <WarehouseSelect items={warehouses.items} allowClear placeholder={t('warehouses.defaultHint')} aria-label={t('stock.receiveWarehouse')} style={{ width: 260 }} value={receiveWarehouse} onChange={setReceiveWarehouse} />
          </Space>
        )}
        <Table<PoLine>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={(po?.lines ?? []).filter((l) => Number(remaining(l)) > 0)}
          columns={[
            { title: t('purchase.product'), render: (_, l) => `${l.productSku} · ${l.productName}` },
            { title: t('purchase.quantity'), align: 'right', render: (_, l) => `${l.quantity} ${l.unit}` },
            { title: t('purchase.receivedQuantity'), align: 'right', render: (_, l) => l.receivedQuantity },
            {
              title: t('purchase.receiveNow'),
              render: (_, l) => (
                <InputNumber<string>
                  stringMode
                  min="0"
                  max={remaining(l)}
                  precision={2}
                  aria-label={`${t('purchase.receiveNow')} ${l.productSku}`}
                  value={receiving?.[l.id]}
                  onChange={(v) => setReceiving({ ...(receiving ?? {}), [l.id]: v ?? '0' })}
                />
              ),
            },
          ]}
        />
      </Modal>

      <Modal
        title={t('purchase.action.cancel')}
        open={cancelReason !== null}
        onCancel={() => setCancelReason(null)}
        okText={t('purchase.confirmCancel')}
        okButtonProps={{ danger: true }}
        zIndex={1100}
        onOk={async () => {
          if (await setStatus('CANCELLED', cancelReason)) setCancelReason(null);
        }}
      >
        <Input.TextArea aria-label={t('purchase.cancelReason')} rows={3} maxLength={500} placeholder={t('purchase.cancelReason')} value={cancelReason ?? ''} onChange={(e) => setCancelReason(e.target.value)} />
      </Modal>
    </Drawer>
  );
}

/**
 * 明细表（含已收数量与合计），详情与打印共用。
 * Lines table with received quantities and totals, shared by the detail and the print page.
 */
export function PoLinesTable({ po }: { po: PurchaseOrder }) {
  return (
    <Table<PoLine>
      rowKey="id"
      size="small"
      pagination={false}
      data-testid="po-lines"
      dataSource={po.lines ?? []}
      columns={[
        { title: '#', dataIndex: 'position', width: 40 },
        { title: t('purchase.sku'), dataIndex: 'productSku' },
        { title: t('purchase.productName'), dataIndex: 'productName' },
        { title: t('purchase.quantity'), align: 'right', render: (_, l) => `${l.quantity} ${l.unit}` },
        { title: t('purchase.receivedQuantity'), align: 'right', render: (_, l) => l.receivedQuantity },
        { title: t('purchase.unitCost'), align: 'right', render: (_, l) => fmtMoney(l.unitCost, po.currency) },
        { title: t('purchase.lineTotal'), align: 'right', render: (_, l) => fmtMoney(l.lineTotal, po.currency) },
      ]}
      summary={() => (
        <>
          {(
            [
              ['purchase.subtotal', po.subtotal],
              ['purchase.taxAmount', po.taxAmount],
              ['purchase.total', po.total],
            ] as const
          ).map(([k, v]) => (
            <Table.Summary.Row key={k}>
              <Table.Summary.Cell index={0} colSpan={6} align="right">
                {k === 'purchase.taxAmount' ? `${t(k)}${t('common.parens', { text: `${Number(po.taxPercent)}%` })}` : t(k)}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                <Typography.Text strong={k === 'purchase.total'}>{fmtMoney(v, po.currency)}</Typography.Text>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          ))}
        </>
      )}
    />
  );
}

/**
 * 销售订单详情中的“采购单”区域（需 purchase.read）：列出由该订单生成的采购单；有 purchase.manage 时可“生成采购单”
 * （复制订单明细，采购单价待填写）。
 * "Purchase orders" section in the sales order detail (purchase.read): lists the orders generated from it; with
 * purchase.manage, "Create purchase order" copies the sales order lines (costs to fill in).
 */
export function SalesOrderPurchases({ salesOrder }: { salesOrder: { id: string; orderNumber: string; status: string } }) {
  const perm = usePermissions();
  const [items, setItems] = useState<PurchaseOrder[]>([]);
  const [creating, setCreating] = useState(false);
  const canRead = perm.can('purchase.read');

  const load = useCallback(async () => {
    if (!canRead) return;
    try {
      setItems((await api<{ items: PurchaseOrder[] }>(`/api/purchase-orders${qs({ salesOrderId: salesOrder.id, pageSize: 50 })}`)).items);
    } catch {
      setItems([]);
    }
  }, [canRead, salesOrder.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (!canRead) return null;
  return (
    <Descriptions column={1} bordered size="small" style={{ marginBottom: 12 }} data-testid="order-purchases">
      <Descriptions.Item label={t('purchase.title')}>
        <Space wrap>
          {items.map((po) => (
            <Space key={po.id} size={4}>
              <Link href={`/purchase-orders?id=${po.id}`}>{po.poNumber}</Link>
              <PoStatusTag status={po.status} />
            </Space>
          ))}
          {perm.can('purchase.manage') && salesOrder.status !== 'CANCELLED' && (
            <Button size="small" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              {t('purchase.fromSo')}
            </Button>
          )}
        </Space>
        <PurchaseOrderForm
          editing={creating ? 'new' : null}
          salesOrder={salesOrder}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      </Descriptions.Item>
    </Descriptions>
  );
}
