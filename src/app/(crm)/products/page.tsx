/**
 * 产品目录页：搜索、筛选、新增/编辑、启用/停用、删除（维护操作仅管理员与经理）。
 * Product catalog page: search, filter, create/edit, activate/deactivate, delete (maintenance for admins and managers).
 */
'use client';

import { useState } from 'react';
import { App, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { usePermissions } from '@/components/AuthProvider';
import { t } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import { toFormErrors, usePagedList } from '@/lib/hooks';
import type { Product } from '@/lib/types';

const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY'].map((v) => ({ value: v, label: v }));
type ActiveFilter = 'true' | 'false' | 'all';

export default function ProductsPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canManage = perm.can('product.manage');
  const [q, setQ] = useState('');
  const [active, setActive] = useState<ActiveFilter>('true');
  const { data, loading, reload, pagination } = usePagedList<Product>('/api/products', { q, active: active === 'all' ? undefined : active });
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [saving, setSaving] = useState(false);

  const openForm = (p: Product | 'new') => {
    form.resetFields();
    if (p !== 'new') form.setFieldsValue(p);
    setEditing(p);
  };

  const save = async () => {
    const values = await form.validateFields();
    const body = { ...values, unitPrice: values.unitPrice === undefined || values.unitPrice === null ? '0' : String(values.unitPrice) };
    setSaving(true);
    try {
      if (editing === 'new') await api('/api/products', { method: 'POST', body });
      else await api(`/api/products/${(editing as Product).id}`, { method: 'PATCH', body });
      message.success(t('common.saved'));
      setEditing(null);
      void reload();
    } catch (err) {
      if (err instanceof ClientApiError) form.setFields(toFormErrors(err.details));
      message.error(err instanceof ClientApiError && err.code === 'CONFLICT' ? t('products.skuTaken') : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      message.success(ok);
      void reload();
    } catch (err) {
      message.error(err instanceof ClientApiError && err.code === 'CONFLICT' ? t('products.inUse') : (err as Error).message);
    }
  };

  return (
    <Card
      title={t('products.title')}
      extra={
        canManage && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm('new')}>
            {t('products.new')}
          </Button>
        )
      }
    >
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented<ActiveFilter>
          value={active}
          onChange={setActive}
          options={[
            { value: 'true', label: t('products.active') },
            { value: 'false', label: t('products.inactive') },
            { value: 'all', label: t('common.all') },
          ]}
        />
        <Input.Search allowClear placeholder={t('products.searchPlaceholder')} style={{ width: 260 }} onSearch={setQ} />
      </Space>
      <Table<Product>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        columns={[
          { title: t('products.sku'), dataIndex: 'sku', width: 150 },
          { title: t('products.name'), dataIndex: 'name' },
          { title: t('products.category'), dataIndex: 'category' },
          { title: t('products.unit'), dataIndex: 'unit', width: 70 },
          { title: t('products.unitPrice'), align: 'right', render: (_, r) => fmtMoney(r.unitPrice, r.currency) },
          {
            title: t('products.status'),
            dataIndex: 'isActive',
            render: (v: boolean) => (v ? <Tag color="green">{t('products.active')}</Tag> : <Tag>{t('products.inactive')}</Tag>),
          },
          { title: t('products.usage'), align: 'right', render: (_, r) => r._count?.lineItems ?? 0 },
          {
            title: t('common.actions'),
            hidden: !canManage,
            render: (_, r) => (
              <Space>
                <Button type="link" size="small" onClick={() => openForm(r)}>
                  {t('common.edit')}
                </Button>
                <Button
                  type="link"
                  size="small"
                  onClick={() => run(() => api(`/api/products/${r.id}`, { method: 'PATCH', body: { isActive: !r.isActive } }), t('common.saved'))}
                >
                  {r.isActive ? t('products.deactivate') : t('products.activate')}
                </Button>
                <Popconfirm title={t('common.confirmDelete')} onConfirm={() => run(() => api(`/api/products/${r.id}`, { method: 'DELETE' }), t('common.deleted'))}>
                  <Button type="link" size="small" danger>
                    {t('common.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={editing === 'new' ? t('products.new') : t('products.edit')}
        open={editing !== null}
        onOk={save}
        onCancel={() => setEditing(null)}
        confirmLoading={saving}
        okText={t('common.save')}
        width={600}
        forceRender
      >
        <Form form={form} name="product" layout="vertical" initialValues={{ unit: '件', currency: 'CNY', isActive: true }}>
          <div className="form-row">
            <Form.Item
              name="sku"
              label={t('products.sku')}
              extra={t('products.skuHint')}
              rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('products.sku') }) }]}
            >
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="name" label={t('products.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('products.name') }) }]}>
              <Input maxLength={200} />
            </Form.Item>
          </div>
          <div className="form-row">
            <Form.Item name="category" label={t('products.category')}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="unit" label={t('products.unit')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('products.unit') }) }]}>
              <Input maxLength={20} />
            </Form.Item>
          </div>
          <div className="form-row">
            <Form.Item name="unitPrice" label={t('products.unitPrice')} rules={[{ pattern: /^\d{1,16}(\.\d{1,2})?$/, message: t('deals.invalidAmount') }]}>
              <InputNumber<string> stringMode min="0" precision={2} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="currency" label={t('products.currency')}>
              <Select options={CURRENCIES} />
            </Form.Item>
            <Form.Item name="isActive" label={t('products.status')} valuePropName="checked">
              <Switch checkedChildren={t('products.active')} unCheckedChildren={t('products.inactive')} />
            </Form.Item>
          </div>
          <Form.Item name="description" label={t('common.description')}>
            <Input.TextArea rows={3} maxLength={5000} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
