/**
 * 商机产品明细：添加产品（仅同币种、启用的产品）、修改数量/单价/折扣、删除；合计即商机金额。
 * 添加时可选价格表（默认用客户的价格表）：按服务端取价自动填入单价与折扣并显示价格来源；用户改过的字段才提交，
 * 未改动时由服务端按同一规则取价并记录价格表名称。
 * Deal line items: add products (same currency, active only), edit quantity/price/discount, remove;
 * the total is the deal amount. Adding can pick a price book (the account's by default): the price and discount are
 * filled from the server-side price with its source shown; only fields the user edited are sent, otherwise the server
 * prices the item by the same rules and records the book name.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Form, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
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

/** 价格表选项：auto 用客户默认，none 不用 / book choice: auto = account default, none = catalogue */
type BookChoice = 'auto' | 'none' | string;

/** 取价预览 / price preview */
interface PricePreview {
  unitPrice: string;
  discountPercent: string;
  lineTotal: string;
  priceBook: { id: string; name: string } | null;
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
  const details = err instanceof ClientApiError ? err.details : undefined;
  const code = details?.productId?.[0];
  if (code) return t(`items.error.${code}` as MessageKey);
  const book = details?.priceBookId?.[0];
  return book ? t(`priceBooks.error.priceBookId.${book}` as MessageKey) : (err as Error).message;
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
  const [books, setBooks] = useState<{ id: string; name: string }[]>([]);
  const [book, setBook] = useState<BookChoice>('auto');
  const [preview, setPreview] = useState<PricePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const quantity = Form.useWatch('quantity', addForm);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // 用户亲手改过的字段（onValuesChange 只由用户输入触发；setFieldsValue 也会标记 touched，不能用）
  // fields the user edited (onValuesChange fires on user input only; setFieldsValue also marks fields touched)
  const edited = useRef({ unitPrice: false, discountPercent: false });

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

  // 可选的价格表：启用、与商机同币种 / selectable books: active, in the deal currency
  useEffect(() => {
    if (!editable) return;
    api<{ items: { id: string; name: string }[] }>(`/api/price-books${qs({ active: 'true', currency: deal.currency, pageSize: 100 })}`)
      .then((r) => setBooks(r.items))
      .catch(() => setBooks([]));
  }, [editable, deal.currency]);

  // 产品、数量或价格表变化时预览取价 / preview the price when the product, quantity or book changes
  useEffect(() => {
    if (!productId || !quantity || Number(quantity) <= 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let live = true;
    api<PricePreview>(`/api/deals/${deal.id}/price${qs({ productId, quantity: String(quantity), priceBookId: book === 'auto' ? undefined : book })}`)
      .then((r) => {
        if (!live) return;
        setPreview(r);
        setPreviewError(null);
        // 只填入用户没有改过的字段 / fill only the fields the user has not edited
        if (!edited.current.unitPrice) addForm.setFieldsValue({ unitPrice: r.unitPrice });
        if (!edited.current.discountPercent) addForm.setFieldsValue({ discountPercent: r.discountPercent });
      })
      .catch((err) => {
        if (!live) return;
        setPreview(null);
        setPreviewError(itemError(err));
      });
    return () => {
      live = false;
    };
  }, [deal.id, productId, quantity, book, addForm]);

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
        body: {
          productId,
          quantity: String(v.quantity ?? '1'),
          // 未改动的字段由服务端取价 / untouched fields are priced by the server
          unitPrice: edited.current.unitPrice && v.unitPrice ? String(v.unitPrice) : undefined,
          discountPercent: edited.current.discountPercent && v.discountPercent ? String(v.discountPercent) : undefined,
          priceBookId: book === 'auto' ? undefined : book === 'none' ? null : book,
        },
      });
      message.success(t('common.saved'));
      setProductId(null);
      setPreview(null);
      edited.current = { unitPrice: false, discountPercent: false };
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
        <Form
          form={addForm}
          name="add-item"
          layout="inline"
          initialValues={{ quantity: '1' }}
          style={{ marginBottom: 12, rowGap: 8 }}
          onValuesChange={(changed: ItemForm) => {
            if ('unitPrice' in changed) edited.current.unitPrice = true;
            if ('discountPercent' in changed) edited.current.discountPercent = true;
          }}
        >
          <Form.Item label={t('priceBooks.title')} style={{ minWidth: 220 }}>
            <Select
              aria-label={t('priceBooks.title')}
              value={book}
              onChange={(v: BookChoice) => {
                edited.current = { unitPrice: false, discountPercent: false };
                addForm.resetFields(['unitPrice', 'discountPercent']);
                setBook(v);
              }}
              popupMatchSelectWidth={false}
              options={[{ value: 'auto', label: t('priceBooks.accountDefault') }, { value: 'none', label: t('priceBooks.catalogue') }, ...books.map((b) => ({ value: b.id, label: b.name }))]}
            />
          </Form.Item>
          <Form.Item label={t('items.product')} style={{ minWidth: 300 }}>
            <Select
              aria-label={t('items.product')}
              showSearch={{ filterOption: false, onSearch: searchProducts }}
              placeholder={t('items.selectProduct')}
              value={productId}
              onChange={(id: string) => {
                // 换产品时重新按价格表填入 / a new product is priced afresh
                edited.current = { unitPrice: false, discountPercent: false };
                addForm.resetFields(['unitPrice', 'discountPercent']);
                setProductId(id);
              }}
              options={options.map((p) => ({ value: p.id, label: `${p.sku} · ${p.name}${t('common.parens', { text: `${fmtMoney(p.unitPrice, p.currency)}/${p.unit}` })}` }))}
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
          <Button type="primary" icon={<PlusOutlined />} disabled={!productId || !!previewError} onClick={add}>
            {t('items.add')}
          </Button>
        </Form>
      )}
      {editable && preview && (
        <Typography.Paragraph type="secondary" data-testid="price-preview" style={{ marginTop: -4 }}>
          {preview.priceBook
            ? t('priceBooks.previewBook', { book: preview.priceBook.name, price: fmtMoney(preview.unitPrice, deal.currency), discount: Number(preview.discountPercent) })
            : t('priceBooks.previewCatalogue', { price: fmtMoney(preview.unitPrice, deal.currency) })}
          {t('priceBooks.previewEditHint')}
        </Typography.Paragraph>
      )}
      {editable && previewError && <Alert type="warning" showIcon title={previewError} style={{ marginBottom: 12 }} data-testid="price-preview-error" />}
      <Table<DealItem>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={items}
        locale={{ emptyText: t('common.empty') }}
        columns={[
          { title: t('products.sku'), dataIndex: 'productSku', width: 140 },
          {
            title: t('products.name'),
            dataIndex: 'productName',
            render: (v: string, r) => (
              <>
                {v}
                {r.priceBookName && (
                  <Tag color="blue" style={{ marginLeft: 6 }}>
                    {r.priceBookName}
                  </Tag>
                )}
              </>
            ),
          },
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
