/**
 * 价格表页（对标 Zoho Price Books）：搜索、按启用状态筛选、详情（阶梯、产品价格、适用客户）、新建、编辑、删除。
 * 所有用户可查看；新建、修改、维护产品价格、指定客户需 product.manage（管理员、经理）。
 * Price books page (cf. Zoho Price Books): search, filter by active state, details (tiers, product prices, accounts),
 * create, edit and delete. Everyone can view; changes need product.manage (admins, managers).
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { App, Button, Card, Descriptions, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { usePermissions } from '@/components/AuthProvider';
import { RecordSelect } from '@/components/RecordSelect';
import { t, type MessageKey } from '@/i18n';
import { api, ClientApiError, qs } from '@/lib/api';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { useOpenFromUrl, usePagedList, useSearch } from '@/lib/hooks';
import type { Product } from '@/lib/types';

const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY'];

type PricingModel = 'FLAT' | 'DIFFERENTIAL';

/** 阶梯 / Tier */
interface Tier {
  fromQuantity: string;
  toQuantity: string | null;
  discountPercent: string;
}

/** 价格表 / Price book */
interface PriceBook {
  id: string;
  name: string;
  currency: string;
  pricingModel: PricingModel;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  _count: { entries: number; accounts: number };
  tiers?: Tier[];
  entries?: { id: string; listPrice: string; product: { id: string; sku: string; name: string; unit: string; unitPrice: string; currency: string; isActive: boolean } }[];
  accounts?: { id: string; name: string }[];
}

interface BookForm {
  name: string;
  currency: string;
  pricingModel: PricingModel;
  description?: string | null;
  isActive: boolean;
  tiers?: { fromQuantity?: string | null; toQuantity?: string | null; discountPercent?: string | null }[];
}

/**
 * 价格表错误提示（阶梯错误带档位序号）。
 * Messages for price book errors (tier errors carry the tier number).
 */
function bookError(err: unknown): string {
  if (!(err instanceof ClientApiError)) return (err as Error).message;
  for (const field of ['tiers', 'currency', 'productId', 'accountId', 'priceBookId', 'name']) {
    const code = err.details?.[field]?.[0];
    if (!code) continue;
    const [key, n] = code.split(':');
    return t(`priceBooks.error.${field}.${key}` as MessageKey, { n: n ?? '' });
  }
  return err.message;
}

/** 定价方式标签 / pricing model tag */
function ModelTag({ model }: { model: PricingModel }) {
  return <Tag color={model === 'DIFFERENTIAL' ? 'purple' : 'default'}>{t(`priceBooks.model.${model}`)}</Tag>;
}

/** 阶梯区间文字 / tier range text */
function tierRange(tier: Tier): string {
  return tier.toQuantity === null ? t('priceBooks.tierOpen', { from: Number(tier.fromQuantity) }) : t('priceBooks.tierRange', { from: Number(tier.fromQuantity), to: Number(tier.toQuantity) });
}

export default function PriceBooksPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canManage = perm.can('product.manage');
  const search = useSearch();
  const [active, setActive] = useState<string>('true');
  const { data, loading, reload, pagination } = usePagedList<PriceBook>('/api/price-books', { q: search.q || undefined, active: active === 'all' ? undefined : active });
  const [detail, setDetail] = useState<PriceBook | null>(null);
  const [editing, setEditing] = useState<PriceBook | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<BookForm>();
  const model = Form.useWatch('pricingModel', form);
  const [entryForm] = Form.useForm<{ productId?: string; listPrice?: string }>();
  const [products, setProducts] = useState<Product[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const openDetail = useCallback(
    (id: string) => {
      api<PriceBook>(`/api/price-books/${id}`)
        .then(setDetail)
        .catch((err: Error) => message.error(err.message));
    },
    [message],
  );
  useOpenFromUrl(openDetail);

  const searchProducts = useCallback(
    (q: string) => {
      if (!detail) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        try {
          const r = await api<{ items: Product[] }>(`/api/products${qs({ q, active: 'true', currency: detail.currency, pageSize: 20 })}`);
          setProducts(r.items);
        } catch {
          setProducts([]);
        }
      }, 250);
    },
    [detail],
  );

  useEffect(() => {
    if (canManage && detail) searchProducts('');
    return () => clearTimeout(timer.current);
  }, [canManage, detail, searchProducts]);

  const refresh = (id: string) => {
    openDetail(id);
    void reload();
  };

  const openForm = (b: PriceBook | 'new') => {
    form.resetFields();
    form.setFieldsValue(
      b === 'new'
        ? { currency: 'CNY', pricingModel: 'FLAT', isActive: true, tiers: [] }
        : { name: b.name, currency: b.currency, pricingModel: b.pricingModel, description: b.description, isActive: b.isActive, tiers: b.tiers ?? [] },
    );
    setEditing(b);
  };

  const save = async () => {
    const v = await form.validateFields();
    const body = {
      ...v,
      description: v.description ?? null,
      tiers:
        v.pricingModel === 'DIFFERENTIAL'
          ? (v.tiers ?? []).map((x) => ({ fromQuantity: String(x.fromQuantity ?? ''), toQuantity: x.toQuantity ? String(x.toQuantity) : null, discountPercent: String(x.discountPercent ?? '0') }))
          : [],
    };
    setSaving(true);
    try {
      const saved = editing === 'new' ? await api<PriceBook>('/api/price-books', { method: 'POST', body }) : await api<PriceBook>(`/api/price-books/${(editing as PriceBook).id}`, { method: 'PATCH', body });
      message.success(t('common.saved'));
      setEditing(null);
      void reload();
      if (detail?.id === saved.id) openDetail(saved.id);
    } catch (err) {
      if (err instanceof ClientApiError && err.details?.name?.[0] === 'taken') form.setFields([{ name: 'name', errors: [t('priceBooks.error.name.taken')] }]);
      else message.error(bookError(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (b: PriceBook) => {
    try {
      await api(`/api/price-books/${b.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      if (detail?.id === b.id) setDetail(null);
      void reload();
    } catch (err) {
      message.error(bookError(err));
    }
  };

  const setPrice = async () => {
    if (!detail) return;
    const v = await entryForm.validateFields();
    try {
      await api(`/api/price-books/${detail.id}/entries`, { method: 'PUT', body: { productId: v.productId, listPrice: String(v.listPrice) } });
      message.success(t('common.saved'));
      entryForm.resetFields();
      refresh(detail.id);
    } catch (err) {
      message.error(bookError(err));
    }
  };

  const removePrice = async (productId: string) => {
    if (!detail) return;
    try {
      await api(`/api/price-books/${detail.id}/entries/${productId}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      refresh(detail.id);
    } catch (err) {
      message.error(bookError(err));
    }
  };

  const assign = async () => {
    if (!detail || !accountId) return;
    try {
      await api(`/api/price-books/${detail.id}/accounts`, { method: 'POST', body: { accountId } });
      message.success(t('common.saved'));
      setAccountId(null);
      refresh(detail.id);
    } catch (err) {
      message.error(bookError(err));
    }
  };

  const unassign = async (id: string) => {
    if (!detail) return;
    try {
      await api(`/api/price-books/${detail.id}/accounts/${id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      refresh(detail.id);
    } catch (err) {
      message.error(bookError(err));
    }
  };

  /** 相对目录价的差异 / difference from the catalogue price */
  const versus = (list: string, catalogue: string) => {
    const base = Number(catalogue);
    if (!base) return null;
    const pct = Math.round(((Number(list) - base) / base) * 1000) / 10;
    return pct === 0 ? t('priceBooks.sameAsCatalogue') : t('priceBooks.versusCatalogue', { pct: pct > 0 ? `+${pct}` : String(pct) });
  };

  return (
    <Card
      title={t('priceBooks.title')}
      extra={
        canManage && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm('new')}>
            {t('priceBooks.new')}
          </Button>
        )
      }
    >
      <Typography.Paragraph type="secondary">{t('priceBooks.intro')}</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented
          value={active}
          onChange={(v) => setActive(String(v))}
          options={[
            { value: 'true', label: t('priceBooks.active') },
            { value: 'false', label: t('priceBooks.inactive') },
            { value: 'all', label: t('common.all') },
          ]}
        />
        <Input.Search allowClear placeholder={t('priceBooks.searchPlaceholder')} style={{ width: 280 }} {...search.inputProps} />
      </Space>
      <Table<PriceBook>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('priceBooks.name'),
            render: (_, r) => (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openDetail(r.id)}>
                {r.name}
              </Button>
            ),
          },
          { title: t('priceBooks.currency'), dataIndex: 'currency' },
          { title: t('priceBooks.pricingModel'), render: (_, r) => <ModelTag model={r.pricingModel} /> },
          { title: t('priceBooks.products'), align: 'right', render: (_, r) => r._count.entries },
          { title: t('priceBooks.accounts'), align: 'right', render: (_, r) => r._count.accounts },
          { title: t('priceBooks.status'), render: (_, r) => (r.isActive ? <Tag color="green">{t('priceBooks.active')}</Tag> : <Tag>{t('priceBooks.inactive')}</Tag>) },
        ]}
      />

      <Drawer
        title={detail ? `${t('priceBooks.detail')} · ${detail.name}` : t('priceBooks.detail')}
        size={820}
        open={detail !== null}
        onClose={() => setDetail(null)}
        extra={
          detail &&
          canManage && (
            <Space>
              <Button onClick={() => openForm(detail)}>{t('common.edit')}</Button>
              <Popconfirm title={detail._count.accounts ? t('priceBooks.confirmDeleteAssigned', { n: detail._count.accounts }) : t('common.confirmDelete')} onConfirm={() => remove(detail)}>
                <Button danger>{t('common.delete')}</Button>
              </Popconfirm>
            </Space>
          )
        }
      >
        {detail && (
          <div data-testid="pricebook-detail">
            <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label={t('priceBooks.currency')}>{detail.currency}</Descriptions.Item>
              <Descriptions.Item label={t('priceBooks.pricingModel')}>
                <ModelTag model={detail.pricingModel} />
              </Descriptions.Item>
              <Descriptions.Item label={t('priceBooks.status')}>{detail.isActive ? t('priceBooks.active') : t('priceBooks.inactive')}</Descriptions.Item>
              <Descriptions.Item label={t('common.createdAt')}>{fmtDateTime(detail.createdAt)}</Descriptions.Item>
              <Descriptions.Item label={t('common.description')} span={2}>
                <span style={{ whiteSpace: 'pre-wrap' }}>{detail.description}</span>
              </Descriptions.Item>
              {detail.pricingModel === 'DIFFERENTIAL' && (
                <Descriptions.Item label={t('priceBooks.tiers')} span={2}>
                  <Space wrap data-testid="pricebook-tiers">
                    {(detail.tiers ?? []).map((tier) => (
                      <Tag key={tier.fromQuantity}>{t('priceBooks.tierText', { range: tierRange(tier), discount: Number(tier.discountPercent) })}</Tag>
                    ))}
                  </Space>
                </Descriptions.Item>
              )}
            </Descriptions>

            <Typography.Title level={5}>{t('priceBooks.products')}</Typography.Title>
            {canManage && (
              <Form form={entryForm} name="pricebook-entry" layout="inline" style={{ marginBottom: 12, rowGap: 8 }}>
                <Form.Item name="productId" label={t('items.product')} rules={[{ required: true, message: t('common.required', { field: t('items.product') }) }]} style={{ minWidth: 320 }}>
                  <Select
                    aria-label={t('items.product')}
                    showSearch={{ filterOption: false, onSearch: searchProducts }}
                    placeholder={t('priceBooks.selectProduct')}
                    popupMatchSelectWidth={false}
                    onChange={(id: string) => {
                      const existing = detail.entries?.find((e) => e.product.id === id);
                      const p = products.find((o) => o.id === id);
                      entryForm.setFieldsValue({ listPrice: existing?.listPrice ?? p?.unitPrice });
                    }}
                    options={products.map((p) => ({ value: p.id, label: `${p.sku} · ${p.name}${t('common.parens', { text: fmtMoney(p.unitPrice, p.currency) })}` }))}
                  />
                </Form.Item>
                <Form.Item name="listPrice" label={t('priceBooks.listPrice')} rules={[{ required: true, message: t('common.required', { field: t('priceBooks.listPrice') }) }]}>
                  <InputNumber<string> stringMode min="0" precision={2} style={{ width: 140 }} aria-label={t('priceBooks.listPrice')} />
                </Form.Item>
                <Button type="primary" onClick={setPrice}>
                  {t('priceBooks.setPrice')}
                </Button>
              </Form>
            )}
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              data-testid="pricebook-entries"
              dataSource={detail.entries ?? []}
              locale={{ emptyText: t('priceBooks.noProducts') }}
              style={{ marginBottom: 24 }}
              columns={[
                { title: t('products.sku'), render: (_, r) => r.product.sku },
                {
                  title: t('products.name'),
                  render: (_, r) => (
                    <>
                      {r.product.name}
                      {!r.product.isActive && <Tag style={{ marginLeft: 6 }}>{t('products.inactive')}</Tag>}
                    </>
                  ),
                },
                { title: t('priceBooks.cataloguePrice'), align: 'right', render: (_, r) => fmtMoney(r.product.unitPrice, r.product.currency) },
                { title: t('priceBooks.listPrice'), align: 'right', render: (_, r) => <Typography.Text strong>{fmtMoney(r.listPrice, detail.currency)}</Typography.Text> },
                { title: t('priceBooks.versus'), align: 'right', render: (_, r) => versus(r.listPrice, r.product.unitPrice) },
                {
                  title: t('common.actions'),
                  hidden: !canManage,
                  render: (_, r) => (
                    <Space>
                      <Button type="link" size="small" onClick={() => entryForm.setFieldsValue({ productId: r.product.id, listPrice: r.listPrice })}>
                        {t('common.edit')}
                      </Button>
                      <Popconfirm title={t('common.confirmDelete')} onConfirm={() => removePrice(r.product.id)}>
                        <Button type="link" size="small" danger aria-label={`${t('common.delete')} ${r.product.sku}`} icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />

            <Typography.Title level={5}>{t('priceBooks.accounts')}</Typography.Title>
            <Typography.Paragraph type="secondary">{t('priceBooks.accountsHint')}</Typography.Paragraph>
            {canManage && detail.isActive && (
              <Space style={{ marginBottom: 12 }} data-testid="pricebook-assign">
                <div style={{ width: 300 }}>
                  <RecordSelect resource="/api/accounts" value={accountId} onChange={setAccountId} placeholder={t('priceBooks.pickAccount')} id="pricebook-account" />
                </div>
                <Button type="primary" disabled={!accountId} onClick={assign}>
                  {t('priceBooks.assign')}
                </Button>
              </Space>
            )}
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              data-testid="pricebook-accounts"
              dataSource={detail.accounts ?? []}
              locale={{ emptyText: t('priceBooks.noAccounts') }}
              columns={[
                { title: t('accounts.name'), render: (_, r) => <Link href={`/accounts?id=${r.id}`}>{r.name}</Link> },
                {
                  title: t('common.actions'),
                  hidden: !canManage,
                  render: (_, r) => (
                    <Popconfirm title={t('priceBooks.confirmUnassign')} onConfirm={() => unassign(r.id)}>
                      <Button type="link" size="small" danger>
                        {t('priceBooks.unassign')}
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Drawer>

      <Modal title={editing === 'new' ? t('priceBooks.new') : t('priceBooks.edit')} open={editing !== null} onOk={save} confirmLoading={saving} onCancel={() => setEditing(null)} okText={t('common.save')} width={680} forceRender zIndex={1100}>
        <Form form={form} name="pricebook" layout="vertical">
          <Form.Item name="name" label={t('priceBooks.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('priceBooks.name') }) }]}>
            <Input maxLength={200} />
          </Form.Item>
          <div className="form-row">
            <Form.Item name="currency" label={t('priceBooks.currency')}>
              <Select options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
            </Form.Item>
            <Form.Item name="pricingModel" label={t('priceBooks.pricingModel')}>
              <Select
                options={[
                  { value: 'FLAT', label: t('priceBooks.model.FLAT') },
                  { value: 'DIFFERENTIAL', label: t('priceBooks.model.DIFFERENTIAL') },
                ]}
              />
            </Form.Item>
            <Form.Item name="isActive" label={t('priceBooks.status')} valuePropName="checked">
              <Switch checkedChildren={t('priceBooks.active')} unCheckedChildren={t('priceBooks.inactive')} />
            </Form.Item>
          </div>
          {model === 'DIFFERENTIAL' && (
            <>
              <Typography.Paragraph type="secondary">{t('priceBooks.tiersHint')}</Typography.Paragraph>
              <Form.List name="tiers">
                {(rows, { add, remove: drop }) => (
                  <div data-testid="tier-editor">
                    {rows.map((row, i) => (
                      <Space key={row.key} align="start" style={{ display: 'flex' }}>
                        <Form.Item name={[row.name, 'fromQuantity']} rules={[{ required: true, message: t('common.required', { field: t('priceBooks.fromQuantity') }) }]}>
                          <InputNumber<string> stringMode min="0.01" precision={2} placeholder={t('priceBooks.fromQuantity')} aria-label={`${t('priceBooks.fromQuantity')} ${i + 1}`} />
                        </Form.Item>
                        <Form.Item name={[row.name, 'toQuantity']}>
                          <InputNumber<string> stringMode min="0.01" precision={2} placeholder={t('priceBooks.toQuantityOpen')} aria-label={`${t('priceBooks.toQuantity')} ${i + 1}`} />
                        </Form.Item>
                        <Form.Item name={[row.name, 'discountPercent']} rules={[{ required: true, message: t('common.required', { field: t('items.discount') }) }]}>
                          <InputNumber<string> stringMode min="0" max="100" precision={2} suffix="%" placeholder={t('items.discount')} aria-label={`${t('items.discount')} ${i + 1}`} />
                        </Form.Item>
                        <Button type="text" danger icon={<DeleteOutlined />} aria-label={`${t('priceBooks.removeTier')} ${i + 1}`} onClick={() => drop(row.name)} />
                      </Space>
                    ))}
                    <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ discountPercent: '0' })} style={{ marginBottom: 16 }}>
                      {t('priceBooks.addTier')}
                    </Button>
                  </div>
                )}
              </Form.List>
            </>
          )}
          <Form.Item name="description" label={t('common.description')}>
            <Input.TextArea rows={3} maxLength={2000} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
