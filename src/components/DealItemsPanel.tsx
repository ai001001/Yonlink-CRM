/**
 * 商机产品明细：添加产品（仅同币种、启用的产品）、修改数量/单价/折扣、删除；合计即商机金额。
 * Deal line items: add products (same currency, active only), edit quantity/price/discount, remove;
 * the total is the deal amount.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Form, InputNumber, Modal, Popconfirm, Select, Space, Table, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { t, type MessageKey } from '@/i18n';
import { api, ClientApiError, qs } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import type { DealItem, Product } from '@/lib/types';
import { usePermissions } from './AuthProvider';

interface Props {
  deal: { id: string; ownerId: string | null; currency: string };
  /** 明细变化后（返回新的商机金额）/ called after a change with the new deal amount */
  onChanged: (dealAmount: string) => void;
}

interface ItemForm {
  quantity?: string | null;
  unitPrice?: string | null;
  discountPercent?: string | null;
}

/**
 * 明细相关错误提示。
 * Messages for line-item errors.
 */
function itemError(err: unknown): string {
  const code = err instanceof ClientApiError ? err.details?.productId?.[0] : undefined;
  return code ? t(`items.error.${code}` as MessageKey) : (err as Error).message;
}

export function DealItemsPanel({ deal, onChanged }: Props) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const editable = perm.canEdit(deal);
  const [items, setItems] = useState<DealItem[]>([]);
  const [total, setTotal] = useState('0.00');
  const [options, setOptions] = useState<Product[]>([]);
  const [productId, setProductId] = useState<string | null>(null);
  const [addForm] = Form.useForm<ItemForm>();
  const [editForm] = Form.useForm<ItemForm>();
  const [editing, setEditing] = useState<DealItem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: DealItem[]; total: string }>(`/api/deals/${deal.id}/items`);
      setItems(r.items);
      setTotal(r.total);
    } catch (err) {
      message.error((err as Error).message);
    }
  }, [deal.id, message]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const searchProducts = useCallback(
    (q: string) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        try {
          const r = await api<{ items: Product[] }>(`/api/products${qs({ q, active: 'true', currency: deal.currency, pageSize: 20 })}`);
          setOptions(r.items);
        } catch {
          setOptions([]);
        }
      }, 250);
    },
    [deal.currency],
  );

  useEffect(() => {
    if (editable) searchProducts('');
    return () => clearTimeout(timer.current);
  }, [editable, searchProducts]);

  const changed = (dealAmount: string) => {
    void load();
    onChanged(dealAmount);
  };

  const add = async () => {
    if (!productId) return;
    const v = await addForm.validateFields();
    try {
      const r = await api<{ dealAmount: string }>(`/api/deals/${deal.id}/items`, {
        method: 'POST',
        body: { productId, quantity: String(v.quantity ?? '1'), unitPrice: v.unitPrice ? String(v.unitPrice) : undefined, discountPercent: String(v.discountPercent ?? '0') },
      });
      message.success(t('common.saved'));
      setProductId(null);
      addForm.resetFields();
      changed(r.dealAmount);
    } catch (err) {
      message.error(itemError(err));
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const v = await editForm.validateFields();
    try {
      const r = await api<{ dealAmount: string }>(`/api/deal-items/${editing.id}`, {
        method: 'PATCH',
        body: { quantity: String(v.quantity), unitPrice: String(v.unitPrice), discountPercent: String(v.discountPercent ?? '0') },
      });
      message.success(t('common.saved'));
      setEditing(null);
      changed(r.dealAmount);
    } catch (err) {
      message.error(itemError(err));
    }
  };

  const remove = async (item: DealItem) => {
    try {
      const r = await api<{ dealAmount: string }>(`/api/deal-items/${item.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      changed(r.dealAmount);
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const numberRules = (max: string) => [{ required: true, message: t('common.required', { field: '' }) }, { type: 'number' as const, max: Number(max), transform: Number }];

  return (
    <div data-testid="deal-items">
      <Alert type="info" showIcon title={t('items.amountHint')} style={{ marginBottom: 12 }} />
      {editable && (
        <Form form={addForm} name="add-item" layout="inline" initialValues={{ quantity: '1', discountPercent: '0' }} style={{ marginBottom: 12, rowGap: 8 }}>
          <Form.Item label={t('items.product')} style={{ minWidth: 300 }}>
            <Select
              aria-label={t('items.product')}
              showSearch={{ filterOption: false, onSearch: searchProducts }}
              placeholder={t('items.selectProduct')}
              value={productId}
              onChange={(id: string) => {
                setProductId(id);
                const p = options.find((o) => o.id === id);
                if (p) addForm.setFieldsValue({ unitPrice: p.unitPrice });
              }}
              options={options.map((p) => ({ value: p.id, label: `${p.sku} · ${p.name}（${fmtMoney(p.unitPrice, p.currency)}/${p.unit}）` }))}
              popupMatchSelectWidth={false}
            />
          </Form.Item>
          <Form.Item name="quantity" label={t('items.quantity')} rules={[{ required: true, message: t('common.required', { field: t('items.quantity') }) }]}>
            <InputNumber<string> stringMode min="0.01" precision={2} style={{ width: 100 }} />
          </Form.Item>
          <Form.Item name="unitPrice" label={t('products.unitPrice')}>
            <InputNumber<string> stringMode min="0" precision={2} style={{ width: 130 }} />
          </Form.Item>
          <Form.Item name="discountPercent" label={t('items.discount')}>
            <InputNumber<string> stringMode min="0" max="100" precision={2} style={{ width: 90 }} />
          </Form.Item>
          <Button type="primary" icon={<PlusOutlined />} disabled={!productId} onClick={add}>
            {t('items.add')}
          </Button>
        </Form>
      )}
      <Table<DealItem>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={items}
        locale={{ emptyText: t('common.empty') }}
        columns={[
          { title: t('products.sku'), dataIndex: 'productSku', width: 140 },
          { title: t('products.name'), dataIndex: 'productName' },
          { title: t('items.quantity'), align: 'right', render: (_, r) => `${r.quantity} ${r.product.unit}` },
          { title: t('products.unitPrice'), dataIndex: 'unitPrice', align: 'right', render: (v: string) => fmtMoney(v, deal.currency) },
          { title: t('items.discount'), dataIndex: 'discountPercent', align: 'right', render: (v: string) => `${Number(v)}%` },
          { title: t('items.lineTotal'), dataIndex: 'lineTotal', align: 'right', render: (v: string) => fmtMoney(v, deal.currency) },
          {
            title: t('common.actions'),
            hidden: !editable,
            render: (_, r) => (
              <Space>
                <Button
                  type="link"
                  size="small"
                  onClick={() => {
                    editForm.setFieldsValue({ quantity: r.quantity, unitPrice: r.unitPrice, discountPercent: r.discountPercent });
                    setEditing(r);
                  }}
                >
                  {t('common.edit')}
                </Button>
                <Popconfirm title={t('common.confirmDelete')} onConfirm={() => remove(r)}>
                  <Button type="link" size="small" danger>
                    {t('common.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0} colSpan={5} align="right">
              <Typography.Text strong>{t('items.total')}</Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={1} align="right">
              <Typography.Text strong data-testid="items-total">
                {fmtMoney(total, deal.currency)}
              </Typography.Text>
            </Table.Summary.Cell>
            {editable && <Table.Summary.Cell index={2} />}
          </Table.Summary.Row>
        )}
      />
      <Modal title={editing ? `${editing.productSku} · ${editing.productName}` : ''} open={editing !== null} onOk={saveEdit} onCancel={() => setEditing(null)} okText={t('common.save')} forceRender zIndex={1100}>
        <Form form={editForm} name="edit-item" layout="vertical">
          <div className="form-row">
            <Form.Item name="quantity" label={t('items.quantity')} rules={numberRules('9999999999')}>
              <InputNumber<string> stringMode min="0.01" precision={2} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="unitPrice" label={t('products.unitPrice')} rules={numberRules('9999999999999999.99')}>
              <InputNumber<string> stringMode min="0" precision={2} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="discountPercent" label={t('items.discount')}>
              <InputNumber<string> stringMode min="0" max="100" precision={2} style={{ width: '100%' }} />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
