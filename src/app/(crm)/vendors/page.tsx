/**
 * 供应商页：搜索、按启用状态筛选、详情（联系方式、付款条件、最近采购单）、新建、编辑、删除（有采购单时只能停用）。
 * 查看需 purchase.read，维护需 purchase.manage。
 * Vendors page: search, filter by active state, details (contact, payment terms, recent purchase orders), create, edit
 * and delete (vendors with purchase orders can only be deactivated). Viewing needs purchase.read, changes purchase.manage.
 */
'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { App, Button, Card, Descriptions, Drawer, Form, Input, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { usePermissions } from '@/components/AuthProvider';
import { PoStatusTag } from '@/components/PurchaseOrderDrawer';
import { t } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { useOpenFromUrl, usePagedList, useSearch } from '@/lib/hooks';

const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY'];

/** 供应商 / Vendor */
interface Vendor {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  currency: string;
  paymentTerms: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  _count: { purchaseOrders: number };
  purchaseOrders?: { id: string; poNumber: string; subject: string; status: string; currency: string; total: string; createdAt: string }[];
}

type VendorForm = Omit<Vendor, 'id' | 'createdAt' | '_count' | 'purchaseOrders'>;

export default function VendorsPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canManage = perm.can('purchase.manage');
  const search = useSearch();
  const [active, setActive] = useState<string>('true');
  const { data, loading, reload, pagination } = usePagedList<Vendor>('/api/vendors', { q: search.q || undefined, active: active === 'all' ? undefined : active });
  const [detail, setDetail] = useState<Vendor | null>(null);
  const [editing, setEditing] = useState<Vendor | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<VendorForm>();

  const openDetail = useCallback(
    (id: string) => {
      api<Vendor>(`/api/vendors/${id}`)
        .then(setDetail)
        .catch((err: Error) => message.error(err.message));
    },
    [message],
  );
  useOpenFromUrl(openDetail);

  const openForm = (v: Vendor | 'new') => {
    form.resetFields();
    form.setFieldsValue(v === 'new' ? { currency: 'CNY', isActive: true } : v);
    setEditing(v);
  };

  const save = async () => {
    const v = await form.validateFields();
    const body = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === undefined ? null : x]));
    setSaving(true);
    try {
      const saved = editing === 'new' ? await api<Vendor>('/api/vendors', { method: 'POST', body }) : await api<Vendor>(`/api/vendors/${(editing as Vendor).id}`, { method: 'PATCH', body });
      message.success(t('common.saved'));
      setEditing(null);
      void reload();
      if (detail?.id === saved.id) openDetail(saved.id);
    } catch (err) {
      if (err instanceof ClientApiError && err.details?.name?.[0] === 'taken') form.setFields([{ name: 'name', errors: [t('vendors.error.taken')] }]);
      else message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (v: Vendor) => {
    try {
      await api(`/api/vendors/${v.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      if (detail?.id === v.id) setDetail(null);
      void reload();
    } catch (err) {
      message.error(err instanceof ClientApiError && err.details?.purchaseOrders ? t('vendors.error.hasOrders') : (err as Error).message);
    }
  };

  return (
    <Card
      title={t('vendors.title')}
      extra={
        canManage && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm('new')}>
            {t('vendors.new')}
          </Button>
        )
      }
    >
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented
          value={active}
          onChange={(v) => setActive(String(v))}
          options={[
            { value: 'true', label: t('vendors.active') },
            { value: 'false', label: t('vendors.inactive') },
            { value: 'all', label: t('common.all') },
          ]}
        />
        <Input.Search allowClear placeholder={t('vendors.searchPlaceholder')} style={{ width: 280 }} {...search.inputProps} />
      </Space>
      <Table<Vendor>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('vendors.name'),
            render: (_, r) => (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openDetail(r.id)}>
                {r.name}
              </Button>
            ),
          },
          { title: t('vendors.contactName'), dataIndex: 'contactName' },
          { title: t('vendors.phone'), dataIndex: 'phone' },
          { title: t('vendors.currency'), dataIndex: 'currency' },
          { title: t('vendors.paymentTerms'), dataIndex: 'paymentTerms' },
          { title: t('vendors.orders'), align: 'right', render: (_, r) => r._count.purchaseOrders },
          { title: t('vendors.status'), render: (_, r) => (r.isActive ? <Tag color="green">{t('vendors.active')}</Tag> : <Tag>{t('vendors.inactive')}</Tag>) },
        ]}
      />

      <Drawer
        title={detail ? `${t('vendors.detail')} · ${detail.name}` : t('vendors.detail')}
        size={720}
        open={detail !== null}
        onClose={() => setDetail(null)}
        extra={
          detail &&
          canManage && (
            <Space>
              <Button onClick={() => openForm(detail)}>{t('common.edit')}</Button>
              <Popconfirm title={t('common.confirmDelete')} onConfirm={() => remove(detail)}>
                <Button danger>{t('common.delete')}</Button>
              </Popconfirm>
            </Space>
          )
        }
      >
        {detail && (
          <div data-testid="vendor-detail">
            <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label={t('vendors.contactName')}>{detail.contactName}</Descriptions.Item>
              <Descriptions.Item label={t('vendors.phone')}>{detail.phone}</Descriptions.Item>
              <Descriptions.Item label={t('vendors.email')}>{detail.email}</Descriptions.Item>
              <Descriptions.Item label={t('vendors.website')}>{detail.website}</Descriptions.Item>
              <Descriptions.Item label={t('vendors.currency')}>{detail.currency}</Descriptions.Item>
              <Descriptions.Item label={t('vendors.paymentTerms')}>{detail.paymentTerms}</Descriptions.Item>
              <Descriptions.Item label={t('vendors.address')} span={2}>
                {detail.address}
              </Descriptions.Item>
              <Descriptions.Item label={t('vendors.status')}>{detail.isActive ? t('vendors.active') : t('vendors.inactive')}</Descriptions.Item>
              <Descriptions.Item label={t('common.createdAt')}>{fmtDateTime(detail.createdAt)}</Descriptions.Item>
              <Descriptions.Item label={t('common.description')} span={2}>
                <span style={{ whiteSpace: 'pre-wrap' }}>{detail.notes}</span>
              </Descriptions.Item>
            </Descriptions>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              title={() => t('vendors.recentOrders')}
              dataSource={detail.purchaseOrders ?? []}
              locale={{ emptyText: t('common.empty') }}
              columns={[
                { title: t('purchase.number'), render: (_, r) => <Link href={`/purchase-orders?id=${r.id}`}>{r.poNumber}</Link> },
                { title: t('purchase.subject'), dataIndex: 'subject' },
                { title: t('purchase.status'), render: (_, r) => <PoStatusTag status={r.status} /> },
                { title: t('purchase.total'), align: 'right', render: (_, r) => fmtMoney(r.total, r.currency) },
              ]}
            />
          </div>
        )}
      </Drawer>

      <Modal title={editing === 'new' ? t('vendors.new') : t('vendors.edit')} open={editing !== null} onOk={save} confirmLoading={saving} onCancel={() => setEditing(null)} okText={t('common.save')} width={680} forceRender zIndex={1100}>
        <Form form={form} name="vendor" layout="vertical">
          <Form.Item name="name" label={t('vendors.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('vendors.name') }) }]}>
            <Input maxLength={200} />
          </Form.Item>
          <div className="form-row">
            <Form.Item name="contactName" label={t('vendors.contactName')}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="phone" label={t('vendors.phone')}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="email" label={t('vendors.email')} rules={[{ type: 'email', message: t('vendors.error.email') }]}>
              <Input maxLength={254} />
            </Form.Item>
          </div>
          <div className="form-row">
            <Form.Item name="currency" label={t('vendors.currency')}>
              <Select options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
            </Form.Item>
            <Form.Item name="paymentTerms" label={t('vendors.paymentTerms')}>
              <Input maxLength={100} placeholder={t('vendors.paymentTermsPlaceholder')} />
            </Form.Item>
            <Form.Item name="isActive" label={t('vendors.status')} valuePropName="checked">
              <Switch checkedChildren={t('vendors.active')} unCheckedChildren={t('vendors.inactive')} />
            </Form.Item>
          </div>
          <Form.Item name="website" label={t('vendors.website')}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="address" label={t('vendors.address')}>
            <Input maxLength={500} />
          </Form.Item>
          <Form.Item name="notes" label={t('common.description')}>
            <Input.TextArea rows={3} maxLength={5000} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
