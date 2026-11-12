/**
 * 客户管理页：列表、搜索、新增/编辑、详情（基本资料 / 联系人 / 跟进记录）、删除。
 * Accounts page: list, search, create/edit, detail (profile / contacts / activities), delete.
 */
'use client';

import { useCallback, useState } from 'react';
import { App, Button, Card, Descriptions, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Tag } from 'antd';
import { PlusOutlined, StarFilled, UploadOutlined } from '@ant-design/icons';
import { AccountDeals } from '@/components/AccountDeals';
import { usePermissions } from '@/components/AuthProvider';
import { BulkBar } from '@/components/BulkBar';
import { TagEditor, TagFilter, TagList, tagsOf } from '@/components/Tags';
import { ExportButton } from '@/components/ExportButton';
import { ImportModal } from '@/components/ImportModal';
import { NotesPanel } from '@/components/NotesPanel';
import { AuditTrail } from '@/components/AuditTrail';
import { ContactsPanel } from '@/components/ContactsPanel';
import { RelatedActivities } from '@/components/RelatedActivities';
import { t, tEnum } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { toFormErrors, useOpenFromUrl, useOwners, usePagedList, useSelection } from '@/lib/hooks';
import type { Account } from '@/lib/types';

const INDUSTRIES = ['MANUFACTURING', 'IT', 'FINANCE', 'RETAIL', 'EDUCATION', 'HEALTHCARE', 'CONSTRUCTION', 'LOGISTICS', 'GOVERNMENT', 'OTHER'];
const industryOptions = INDUSTRIES.map((v) => ({ value: v, label: tEnum('industry', v) }));

export default function AccountsPage() {
  const { message } = App.useApp();
  const owners = useOwners();
  const perm = usePermissions();
  const [q, setQ] = useState('');
  const [tagId, setTagId] = useState<string>();
  const [industry, setIndustry] = useState<string>();
  const { data, loading, reload, pagination } = usePagedList<Account>('/api/accounts', { q, industry, tagId });
  const sel = useSelection(data.items, perm.can('record.update.own') || perm.canDelete);

  const [form] = Form.useForm();
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<Account | null>(null);
  const [importing, setImporting] = useState(false);

  const openDetail = useCallback(
    async (id: string) => {
      try {
        setDetail(await api<Account>(`/api/accounts/${id}`));
      } catch (err) {
        message.error((err as Error).message);
      }
    },
    [message],
  );

  useOpenFromUrl(openDetail);

  const openForm = (account: Account | 'new') => {
    form.resetFields();
    if (account !== 'new') form.setFieldsValue(account);
    setEditing(account);
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const saved =
        editing === 'new'
          ? await api<Account>('/api/accounts', { method: 'POST', body: values })
          : await api<Account>(`/api/accounts/${(editing as Account).id}`, { method: 'PATCH', body: values });
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

  const remove = async (account: Account) => {
    try {
      await api(`/api/accounts/${account.id}`, { method: 'DELETE' });
      message.success(t('recycle.moved', { days: 30 }));
      if (detail?.id === account.id) setDetail(null);
      void reload();
    } catch (err) {
      message.error(err instanceof ClientApiError && err.code === 'CONFLICT' ? t('accounts.hasDeals') : (err as Error).message);
    }
  };

  const primary = (a: Account) => a.contacts?.find((c) => c.isPrimary);

  return (
    <Card
      title={t('accounts.title')}
      extra={
        <Space>
          {perm.canCreate && (
            <Button icon={<UploadOutlined />} onClick={() => setImporting(true)}>
              {t('import.button')}
            </Button>
          )}
          <ExportButton resource="accounts" filters={{ q, industry }} />
          {perm.canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm('new')}>
              {t('accounts.new')}
            </Button>
          )}
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search allowClear placeholder={t('accounts.searchPlaceholder')} style={{ width: 320 }} onSearch={setQ} />
        <TagFilter value={tagId} onChange={setTagId} onManaged={() => void reload()} />
        <Select allowClear placeholder={t('accounts.industry')} style={{ width: 140 }} options={industryOptions} value={industry} onChange={setIndustry} />
      </Space>
      <BulkBar
        path="/api/accounts"
        taggable
        selected={sel.selected}
        names={Object.fromEntries(data.items.map((r) => [r.id, r.name]))}
        onDone={() => {
          sel.clear();
          void reload();
        }}
        onClear={sel.clear}
      />
      <Table<Account>
        rowKey="id"
        rowSelection={sel.rowSelection}
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        columns={[
          {
            title: t('accounts.name'),
            dataIndex: 'name',
            render: (v: string, r) => (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openDetail(r.id)}>
                {v}
              </Button>
            ),
          },
          { title: t('accounts.industry'), dataIndex: 'industry', render: (v: string | null) => tEnum('industry', v) },
          { title: t('accounts.phone'), dataIndex: 'phone' },
          { title: t('accounts.contactCount'), render: (_, r) => r._count.contacts },
          { title: t('accounts.dealCount'), render: (_, r) => r._count.deals },
          { title: t('tags.title'), render: (_, r) => <TagList tags={tagsOf(r)} /> },
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
                {perm.canDelete && (
                  <Popconfirm title={t('recycle.confirmDelete')} onConfirm={() => remove(r)}>
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
        title={editing === 'new' ? t('accounts.new') : t('accounts.edit')}
        open={editing !== null}
        onOk={save}
        confirmLoading={saving}
        onCancel={() => setEditing(null)}
        okText={t('common.save')}
        width={640}
        forceRender
        zIndex={1100}
      >
        <Form form={form} name="account" layout="vertical">
          <div className="form-row">
            <Form.Item
              name="name"
              label={t('accounts.name')}
              rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('accounts.name') }) }]}
            >
              <Input maxLength={200} />
            </Form.Item>
            <Form.Item name="industry" label={t('accounts.industry')}>
              <Select allowClear options={industryOptions} />
            </Form.Item>
          </div>
          <div className="form-row">
            <Form.Item name="phone" label={t('accounts.phone')}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="website" label={t('accounts.website')}>
              <Input maxLength={254} />
            </Form.Item>
            <Form.Item name="ownerId" label={t('common.owner')} extra={perm.canAssign ? undefined : t('common.ownerLocked')}>
              <Select allowClear={perm.canAssign} disabled={!perm.canAssign} options={owners.map((u) => ({ value: u.id, label: u.name }))} />
            </Form.Item>
          </div>
          <Form.Item name="address" label={t('accounts.address')}>
            <Input maxLength={500} />
          </Form.Item>
          <Form.Item name="description" label={t('common.description')}>
            <Input.TextArea rows={3} maxLength={5000} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={detail ? `${t('accounts.detail')} · ${detail.name}` : t('accounts.detail')}
        size={760}
        open={detail !== null}
        onClose={() => setDetail(null)}
        extra={detail && perm.canEdit(detail) && <Button onClick={() => openForm(detail)}>{t('common.edit')}</Button>}
      >
        {detail && (
          <Tabs
            items={[
              {
                key: 'profile',
                label: t('accounts.tabProfile'),
                children: (
                  <Descriptions column={2} bordered size="small">
                    <Descriptions.Item label={t('accounts.name')}>{detail.name}</Descriptions.Item>
                    <Descriptions.Item label={t('accounts.industry')}>{tEnum('industry', detail.industry)}</Descriptions.Item>
                    <Descriptions.Item label={t('accounts.phone')}>{detail.phone}</Descriptions.Item>
                    <Descriptions.Item label={t('accounts.website')}>{detail.website}</Descriptions.Item>
                    <Descriptions.Item label={t('accounts.address')} span={2}>
                      {detail.address}
                    </Descriptions.Item>
                    <Descriptions.Item label={t('contacts.isPrimary')}>
                      {primary(detail) && (
                        <Tag icon={<StarFilled />} color="gold">
                          {primary(detail)?.name}
                        </Tag>
                      )}
                    </Descriptions.Item>
                    <Descriptions.Item label={t('common.owner')}>{detail.owner?.name ?? t('common.unassigned')}</Descriptions.Item>
                    <Descriptions.Item label={t('accounts.dealCount')}>{detail._count.deals}</Descriptions.Item>
                    <Descriptions.Item label={t('common.createdAt')}>{fmtDateTime(detail.createdAt)}</Descriptions.Item>
                    <Descriptions.Item label={t('tags.title')} span={2}>
                      <TagEditor key={`tags-${detail.id}`} path="/api/accounts" record={detail} onChanged={() => void reload()} />
                    </Descriptions.Item>
                    <Descriptions.Item label={t('common.description')} span={2}>
                      {detail.description}
                    </Descriptions.Item>
                  </Descriptions>
                ),
              },
              {
                key: 'notes',
                label: t('notes.title'),
                children: <NotesPanel key={`notes-${detail.id}`} parent={{ accountId: detail.id }} ownerId={detail.ownerId} />,
              },
              {
                key: 'contacts',
                label: `${t('accounts.tabContacts')} (${detail.contacts?.length ?? 0})`,
                children: (
                  <ContactsPanel
                    editable={perm.canEdit(detail)}
                    accountId={detail.id}
                    contacts={detail.contacts ?? []}
                    onChanged={() => {
                      void openDetail(detail.id);
                      void reload();
                    }}
                  />
                ),
              },
              { key: 'deals', label: `${t('accounts.tabDeals')} (${detail._count.deals})`, children: <AccountDeals accountId={detail.id} /> },
              { key: 'activities', label: t('accounts.tabActivities'), children: <RelatedActivities relation={{ accountId: detail.id }} /> },
              { key: 'audit', label: t('audit.trail'), children: <AuditTrail entityType="account" entityId={detail.id} version={detail.updatedAt} /> },
            ]}
          />
        )}
      </Drawer>
      <ImportModal resource="accounts" open={importing} onClose={() => setImporting(false)} onImported={() => { setImporting(false); void reload(); }} />
    </Card>
  );
}
