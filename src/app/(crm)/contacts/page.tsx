/**
 * 联系人页：全部可见联系人（跨客户），按姓名、职位、电话、邮箱、客户搜索，按客户、负责人、是否主要联系人筛选；
 * 查看详情、新建（选择所属客户）、编辑、删除、导出。负责人与编辑权限跟随所属客户。
 * Contacts page: all visible contacts across accounts with search, account / owner / primary filters, details,
 * create (under a chosen account), edit, delete and export. Owner and edit rights follow the account.
 */
'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { App, Button, Card, Checkbox, Descriptions, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { PlusOutlined, StarFilled, StarOutlined } from '@ant-design/icons';
import { usePermissions } from '@/components/AuthProvider';
import { ExportButton } from '@/components/ExportButton';
import { ScoreDetail, ScoreFilters, ScoreTag, ScoringRulesModal, useScoring } from '@/components/Scoring';
import { RecordSelect } from '@/components/RecordSelect';
import { t } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { toFormErrors, useOpenFromUrl, useOwners, usePagedList, useSearch } from '@/lib/hooks';
import type { ContactRow } from '@/lib/types';
import { CustomFieldItems, CustomFieldValues, useCustomFields } from '@/components/CustomFields';
import { ContactPortal } from '@/components/ContactPortal';

type Primary = 'true' | 'false';

export default function ContactsPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const owners = useOwners();
  const search = useSearch();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ownerId, setOwnerId] = useState<string>();
  const [primary, setPrimary] = useState<Primary>();
  const [grade, setGrade] = useState<string>();
  const [sort, setSort] = useState<string>();
  const filters = { q: search.q || undefined, accountId: accountId ?? undefined, ownerId, isPrimary: primary, grade };
  const { data, loading, reload, pagination } = usePagedList<ContactRow>('/api/contacts', { ...filters, sort });
  const scoring = useScoring('contact');
  const [scoringOpen, setScoringOpen] = useState(false);
  const [detail, setDetail] = useState<ContactRow | null>(null);
  const [editing, setEditing] = useState<ContactRow | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const customDefs = useCustomFields('CONTACT');

  const openDetail = useCallback(
    (id: string) => {
      api<ContactRow>(`/api/contacts/${id}`)
        .then(setDetail)
        .catch((err: Error) => message.error(err.message));
    },
    [message],
  );
  useOpenFromUrl(openDetail);

  /** 编辑权限跟随所属客户 / edit rights follow the account */
  const canEdit = (c: ContactRow) => perm.canEdit(c.account);

  const openForm = (c: ContactRow | 'new') => {
    form.resetFields();
    if (c === 'new') form.setFieldsValue({ accountId: accountId ?? undefined, isPrimary: false });
    else form.setFieldsValue({ name: c.name, title: c.title, phone: c.phone, email: c.email, isPrimary: c.isPrimary, custom: c.custom ?? {} });
    setEditing(c);
  };

  const save = async () => {
    const { accountId: target, ...values } = await form.validateFields();
    setSaving(true);
    try {
      const saved =
        editing === 'new'
          ? await api<{ id: string }>(`/api/accounts/${target}/contacts`, { method: 'POST', body: values })
          : await api<{ id: string }>(`/api/contacts/${(editing as ContactRow).id}`, { method: 'PATCH', body: values });
      message.success(t('common.saved'));
      setEditing(null);
      void reload();
      if (detail?.id === saved.id) openDetail(saved.id);
    } catch (err) {
      if (err instanceof ClientApiError) form.setFields(toFormErrors(err.details));
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: ContactRow) => {
    try {
      await api(`/api/contacts/${c.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      if (detail?.id === c.id) setDetail(null);
      void reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <Card
      title={t('contacts.pageTitle')}
      extra={
        <Space>
          <Button icon={<StarOutlined />} onClick={() => setScoringOpen(true)}>
            {t('scoring.title')}
          </Button>
          <ExportButton excel resource="contacts" filters={filters} />
          {perm.canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm('new')}>
              {t('contacts.new')}
            </Button>
          )}
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">{t('contacts.listHint')}</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search allowClear placeholder={t('contacts.searchPlaceholder')} style={{ width: 320 }} {...search.inputProps} />
        <div style={{ width: 220 }}>
          <RecordSelect resource="/api/accounts" value={accountId} onChange={setAccountId} placeholder={t('contacts.account')} id="contacts-account-filter" />
        </div>
        {perm.can('record.read.all') && (
          <Select
            allowClear
            aria-label={t('common.owner')}
            placeholder={t('common.owner')}
            style={{ width: 140 }}
            value={ownerId}
            onChange={setOwnerId}
            options={owners.map((u) => ({ value: u.id, label: u.name }))}
          />
        )}
        <Select<Primary>
          allowClear
          aria-label={t('contacts.primaryFilter')}
          placeholder={t('contacts.primaryFilter')}
          style={{ width: 150 }}
          value={primary}
          onChange={setPrimary}
          options={[
            { value: 'true', label: t('contacts.primaryOnly') },
            { value: 'false', label: t('contacts.nonPrimary') },
          ]}
        />
        <ScoreFilters grade={grade} onGrade={setGrade} sort={sort} onSort={setSort} />
      </Space>
      <Table<ContactRow>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('contacts.name'),
            dataIndex: 'name',
            render: (v: string, r) => (
              <Space size={4}>
                <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openDetail(r.id)}>
                  {v}
                </Button>
                {r.isPrimary && <StarFilled style={{ color: '#faad14' }} aria-label={t('contacts.isPrimary')} />}
              </Space>
            ),
          },
          { title: t('contacts.title'), dataIndex: 'title' },
          { title: t('contacts.phone'), dataIndex: 'phone' },
          { title: t('contacts.email'), dataIndex: 'email' },
          { title: t('contacts.account'), render: (_, r) => <Link href={`/accounts?id=${r.account.id}`}>{r.account.name}</Link> },
          { title: t('common.owner'), render: (_, r) => r.account.owner?.name ?? t('common.unassigned') },
          { title: t('scoring.score'), dataIndex: 'score', render: (v: number) => <ScoreTag score={v} config={scoring.config} /> },
          { title: t('common.createdAt'), dataIndex: 'createdAt', render: fmtDateTime },
          {
            title: t('common.actions'),
            render: (_, r) =>
              canEdit(r) && (
                <Space>
                  <Button type="link" size="small" onClick={() => openForm(r)}>
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
      />

      <Drawer title={detail ? `${t('contacts.detail')} · ${detail.name}` : t('contacts.detail')} size={560} open={detail !== null} onClose={() => setDetail(null)}>
        {detail && (
          <div data-testid="contact-detail">
            {canEdit(detail) && (
              <Space style={{ marginBottom: 16 }}>
                <Button onClick={() => openForm(detail)}>{t('common.edit')}</Button>
              </Space>
            )}
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label={t('contacts.name')}>
                <Space size={4}>
                  {detail.name}
                  {detail.isPrimary && <Tag color="gold">{t('contacts.isPrimary')}</Tag>}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('contacts.title')}>{detail.title}</Descriptions.Item>
              <Descriptions.Item label={t('contacts.phone')}>{detail.phone}</Descriptions.Item>
              <Descriptions.Item label={t('contacts.email')}>{detail.email}</Descriptions.Item>
              <Descriptions.Item label={t('contacts.account')}>
                <Link href={`/accounts?id=${detail.account.id}`}>{detail.account.name}</Link>
              </Descriptions.Item>
              <Descriptions.Item label={t('common.owner')}>{detail.account.owner?.name ?? t('common.unassigned')}</Descriptions.Item>
              <Descriptions.Item label={t('common.createdAt')}>{fmtDateTime(detail.createdAt)}</Descriptions.Item>
              <Descriptions.Item label={t('scoring.score')}>
                <Space orientation="vertical" size={4}>
                  <ScoreTag score={detail.score} config={scoring.config} />
                  <ScoreDetail entity="contact" id={detail.id} version={`${detail.updatedAt ?? ''}:${detail.score}`} />
                </Space>
              </Descriptions.Item>
            </Descriptions>
            <CustomFieldValues defs={customDefs} values={detail.custom} />
            {perm.can('portal.manage') && <ContactPortal contactId={detail.id} />}
          </div>
        )}
      </Drawer>
      <ScoringRulesModal entity="contact" open={scoringOpen} onClose={() => setScoringOpen(false)} config={scoring.config} canManage={perm.can('scoring.manage')} onSaved={() => { scoring.reload(); void reload(); }} />

      <Modal
        title={editing === 'new' ? t('contacts.new') : t('contacts.edit')}
        open={editing !== null}
        onOk={save}
        confirmLoading={saving}
        onCancel={() => setEditing(null)}
        okText={t('common.save')}
        forceRender
        zIndex={1100}
      >
        <Form form={form} name="contact" layout="vertical">
          {editing === 'new' ? (
            <Form.Item name="accountId" label={t('contacts.account')} rules={[{ required: true, message: t('common.required', { field: t('contacts.account') }) }]}>
              <RecordSelect resource="/api/accounts" placeholder={t('contacts.account')} />
            </Form.Item>
          ) : (
            // 所属客户创建后不可更改 / the account cannot change after creation
            <Form.Item label={t('contacts.account')}>
              <Input disabled value={editing?.account.name ?? ''} />
            </Form.Item>
          )}
          <Form.Item name="name" label={t('contacts.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('contacts.name') }) }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="title" label={t('contacts.title')}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="phone" label={t('contacts.phone')}>
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item name="email" label={t('contacts.email')} rules={[{ type: 'email', message: t('error.VALIDATION_ERROR') }]}>
            <Input maxLength={254} />
          </Form.Item>
          <CustomFieldItems defs={customDefs} />
          <Form.Item name="isPrimary" valuePropName="checked">
            <Checkbox>{t('contacts.isPrimary')}</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
