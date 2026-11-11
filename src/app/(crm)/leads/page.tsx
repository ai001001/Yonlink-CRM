/**
 * 线索管理页：列表、搜索、筛选、新增/编辑、详情、删除。
 * Leads page: list, search, filter, create/edit, detail, delete.
 */
'use client';

import { useCallback, useState } from 'react';
import { App, Button, Card, Descriptions, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import Link from 'next/link';
import { PlusOutlined, SwapOutlined } from '@ant-design/icons';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { toFormErrors, useOpenFromUrl, useOwners, usePagedList, useSelection } from '@/lib/hooks';
import { AuditTrail } from '@/components/AuditTrail';
import { usePermissions } from '@/components/AuthProvider';
import { BulkBar } from '@/components/BulkBar';
import { ConvertLeadModal } from '@/components/ConvertLeadModal';
import { RelatedActivities } from '@/components/RelatedActivities';
import type { Ref } from '@/lib/types';

/** 线索 / Lead */
interface Lead {
  id: string;
  name: string;
  company: string | null;
  title: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  source: string | null;
  status: string;
  description: string | null;
  ownerId: string | null;
  owner: { id: string; name: string } | null;
  convertedAt: string | null;
  convertedAccount: Ref | null;
  convertedContact: Ref | null;
  convertedDeal: Ref | null;
  createdAt: string;
  updatedAt: string;
}

const STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED'] as const;
const SOURCES = ['WEBSITE', 'REFERRAL', 'EXHIBITION', 'COLD_CALL', 'ADVERTISEMENT', 'SOCIAL_MEDIA', 'OTHER'] as const;
const STATUS_COLOR: Record<string, string> = { NEW: 'blue', CONTACTED: 'cyan', QUALIFIED: 'green', UNQUALIFIED: 'default', CONVERTED: 'purple' };

const statusOptions = STATUSES.map((s) => ({ value: s, label: tEnum('leadStatus', s) }));
// “已转化”只能通过转化操作设置 / CONVERTED is only set by the conversion action
const editableStatusOptions = statusOptions.filter((o) => o.value !== 'CONVERTED');
const sourceOptions = SOURCES.map((s) => ({ value: s, label: tEnum('leadSource', s) }));
const req = (key: MessageKey) => [{ required: true, whitespace: true, message: t('common.required', { field: t(key) }) }];

export default function LeadsPage() {
  const { message } = App.useApp();
  const owners = useOwners();
  const perm = usePermissions();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>();
  const [source, setSource] = useState<string>();
  const { data, loading, reload, pagination } = usePagedList<Lead>('/api/leads', { q, status, source });
  const sel = useSelection(data.items, perm.can('record.update.own') || perm.canDelete);

  const [form] = Form.useForm();
  const [editing, setEditing] = useState<Lead | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<Lead | null>(null);
  const [converting, setConverting] = useState<Lead | null>(null);
  const editingConverted = editing !== null && editing !== 'new' && editing.convertedAt !== null;

  useOpenFromUrl(
    useCallback(
      (id: string) => {
        api<Lead>(`/api/leads/${id}`)
          .then(setDetail)
          .catch((err: Error) => message.error(err.message));
      },
      [message],
    ),
  );

  const openForm = (lead: Lead | 'new') => {
    form.resetFields();
    if (lead !== 'new') form.setFieldsValue(lead);
    setEditing(lead);
  };

  const save = async () => {
    const values = await form.validateFields();
    if (editingConverted) delete values.status;
    setSaving(true);
    try {
      const saved =
        editing === 'new'
          ? await api<Lead>('/api/leads', { method: 'POST', body: values })
          : await api<Lead>(`/api/leads/${(editing as Lead).id}`, { method: 'PATCH', body: values });
      message.success(t('common.saved'));
      setEditing(null);
      if (detail?.id === saved.id) setDetail(saved);
      void reload();
    } catch (err) {
      if (err instanceof ClientApiError) form.setFields(toFormErrors(err.details));
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (lead: Lead) => {
    try {
      await api(`/api/leads/${lead.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      if (detail?.id === lead.id) setDetail(null);
      void reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <Card
      title={t('leads.title')}
      extra={
        perm.canCreate && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm('new')}>
            {t('leads.new')}
          </Button>
        )
      }
    >
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search allowClear placeholder={t('leads.searchPlaceholder')} style={{ width: 280 }} onSearch={setQ} data-testid="leads-search" />
        <Select allowClear placeholder={t('leads.status')} style={{ width: 140 }} options={statusOptions} value={status} onChange={setStatus} />
        <Select allowClear placeholder={t('leads.source')} style={{ width: 140 }} options={sourceOptions} value={source} onChange={setSource} />
      </Space>
      <BulkBar
        path="/api/leads"
        selected={sel.selected}
        names={Object.fromEntries(data.items.map((r) => [r.id, r.name]))}
        valueChange={{ action: 'status', field: 'status', options: editableStatusOptions }}
        onDone={() => {
          sel.clear();
          void reload();
        }}
        onClear={sel.clear}
      />
      <Table<Lead>
        rowKey="id"
        rowSelection={sel.rowSelection}
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        columns={[
          { title: t('leads.name'), dataIndex: 'name', render: (v: string, r) => (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setDetail(r)}>
                {v}
              </Button>
            ), },
          { title: t('leads.company'), dataIndex: 'company' },
          { title: t('leads.contact'), render: (_, r) => r.mobile ?? r.phone ?? r.email },
          { title: t('leads.source'), dataIndex: 'source', render: (v: string | null) => tEnum('leadSource', v) },
          { title: t('leads.status'), dataIndex: 'status', render: (v: string) => <Tag color={STATUS_COLOR[v]}>{tEnum('leadStatus', v)}</Tag> },
          { title: t('common.owner'), render: (_, r) => r.owner?.name ?? t('common.unassigned') },
          { title: t('common.createdAt'), dataIndex: 'createdAt', render: fmtDateTime },
          {
            title: t('common.actions'),
            render: (_, r) => (
              <Space>
                {perm.canEdit(r) && (
                  <Button type="link" size="small" onClick={() => openForm(r)}>
                    {t('common.edit')}
                  </Button>
                )}
                {perm.canEdit(r) && perm.canCreate && (
                  <Button type="link" size="small" disabled={r.convertedAt !== null} onClick={() => setConverting(r)}>
                    {t('convert.action')}
                  </Button>
                )}
                {perm.canDelete && (
                  <Popconfirm title={t('common.confirmDelete')} onConfirm={() => remove(r)}>
                    <Button type="link" size="small" danger>
                      {t('common.delete')}
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing === 'new' ? t('leads.new') : t('leads.edit')}
        open={editing !== null}
        onOk={save}
        confirmLoading={saving}
        onCancel={() => setEditing(null)}
        okText={t('common.save')}
        width={640}
        destroyOnHidden
        forceRender
        // 从详情抽屉打开编辑时须位于抽屉之上 / must stack above the detail drawer
        zIndex={1100}
      >
        <Form form={form} name="lead" layout="vertical" initialValues={{ status: 'NEW' }}>
          <div className="form-row">
            <Form.Item name="name" label={t('leads.name')} rules={req('leads.name')}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="company" label={t('leads.company')}>
              <Input maxLength={200} />
            </Form.Item>
          </div>
          <div className="form-row">
            <Form.Item name="title" label={t('leads.jobTitle')}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="email" label={t('leads.email')} rules={[{ type: 'email', message: t('common.invalidEmail') }]}>
              <Input maxLength={254} />
            </Form.Item>
          </div>
          <div className="form-row">
            <Form.Item name="phone" label={t('leads.phone')}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="mobile" label={t('leads.mobile')}>
              <Input maxLength={50} />
            </Form.Item>
          </div>
          <div className="form-row">
            <Form.Item name="source" label={t('leads.source')}>
              <Select allowClear options={sourceOptions} />
            </Form.Item>
            <Form.Item name="status" label={t('leads.status')} extra={editingConverted ? t('convert.statusLocked') : undefined}>
              <Select options={editingConverted ? statusOptions : editableStatusOptions} disabled={editingConverted} />
            </Form.Item>
            <Form.Item name="ownerId" label={t('common.owner')} extra={perm.canAssign ? undefined : t('common.ownerLocked')}>
              <Select allowClear={perm.canAssign} disabled={!perm.canAssign} options={owners.map((u) => ({ value: u.id, label: u.name }))} />
            </Form.Item>
          </div>
          <Form.Item name="description" label={t('common.description')}>
            <Input.TextArea rows={3} maxLength={5000} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={t('leads.detail')}
        size={640}
        open={detail !== null}
        onClose={() => setDetail(null)}
        extra={
          detail && (
            <Space>
              {!detail.convertedAt && perm.canEdit(detail) && perm.canCreate && (
                <Button type="primary" icon={<SwapOutlined />} onClick={() => setConverting(detail)}>
                  {t('convert.action')}
                </Button>
              )}
              {perm.canEdit(detail) && <Button onClick={() => openForm(detail)}>{t('common.edit')}</Button>}
            </Space>
          )
        }
      >
        {detail && (
          <>
            <Descriptions column={2} bordered size="small">
              <Descriptions.Item label={t('leads.name')}>{detail.name}</Descriptions.Item>
              <Descriptions.Item label={t('leads.company')}>{detail.company}</Descriptions.Item>
              <Descriptions.Item label={t('leads.jobTitle')}>{detail.title}</Descriptions.Item>
              <Descriptions.Item label={t('leads.email')}>{detail.email}</Descriptions.Item>
              <Descriptions.Item label={t('leads.phone')}>{detail.phone}</Descriptions.Item>
              <Descriptions.Item label={t('leads.mobile')}>{detail.mobile}</Descriptions.Item>
              <Descriptions.Item label={t('leads.source')}>{tEnum('leadSource', detail.source)}</Descriptions.Item>
              <Descriptions.Item label={t('leads.status')}>{tEnum('leadStatus', detail.status)}</Descriptions.Item>
              <Descriptions.Item label={t('common.owner')}>{detail.owner?.name ?? t('common.unassigned')}</Descriptions.Item>
              <Descriptions.Item label={t('common.createdAt')}>{fmtDateTime(detail.createdAt)}</Descriptions.Item>
              <Descriptions.Item label={t('common.description')} span={2}>
                {detail.description}
              </Descriptions.Item>
            </Descriptions>
            {detail.convertedAt && (
              <Descriptions column={1} bordered size="small" title={t('convert.result')} style={{ marginTop: 24 }} data-testid="conversion-result">
                <Descriptions.Item label={t('convert.convertedAt')}>{fmtDateTime(detail.convertedAt)}</Descriptions.Item>
                <Descriptions.Item label={t('nav.accounts')}>
                  {detail.convertedAccount && <Link href={`/accounts?id=${detail.convertedAccount.id}`}>{detail.convertedAccount.name}</Link>}
                </Descriptions.Item>
                <Descriptions.Item label={t('convert.contact')}>{detail.convertedContact?.name}</Descriptions.Item>
                <Descriptions.Item label={t('nav.deals')}>
                  {detail.convertedDeal && <Link href={`/deals?id=${detail.convertedDeal.id}`}>{detail.convertedDeal.name}</Link>}
                </Descriptions.Item>
              </Descriptions>
            )}
            <Typography.Title level={5} style={{ marginTop: 24 }}>
              {t('accounts.tabActivities')}
            </Typography.Title>
            <RelatedActivities key={detail.convertedAt ?? 'open'} relation={{ leadId: detail.id }} />
            <Typography.Title level={5} style={{ marginTop: 24 }}>
              {t('audit.trail')}
            </Typography.Title>
            <AuditTrail entityType="lead" entityId={detail.id} version={`${detail.updatedAt}${detail.convertedAt ?? ''}`} />
          </>
        )}
      </Drawer>
      <ConvertLeadModal
        lead={converting}
        onClose={() => setConverting(null)}
        onConverted={async () => {
          const id = converting?.id;
          setConverting(null);
          void reload();
          if (id && detail?.id === id) setDetail(await api<Lead>(`/api/leads/${id}`));
        }}
      />
    </Card>
  );
}
