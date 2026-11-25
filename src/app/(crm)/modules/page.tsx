/**
 * 自定义模块的记录页（/modules?m=模块ID）：按名称搜索、按负责人筛选；列表显示名称、前几个字段、关联客户、负责人与
 * 更新时间；新建、编辑（负责人或编辑全部权限，模块须启用）、删除（删除权限）；详情显示全部字段。?id= 打开记录详情。
 * Custom module records (/modules?m=<module id>): search by name, filter by owner; the list shows the name, the first
 * fields, related account, owner and update time; create, edit (owner or update-all, active modules only) and delete
 * (delete permission); the detail shows every field. ?id= opens a record.
 */
'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Alert, App, Button, Card, Descriptions, Drawer, Form, Input, Modal, Popconfirm, Result, Select, Space, Table, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { usePermissions } from '@/components/AuthProvider';
import { CustomFieldItems, CustomFieldValues, type CustomFieldDef } from '@/components/CustomFields';
import { RecordSelect } from '@/components/RecordSelect';
import { t } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { toFormErrors, useOpenFromUrl, useOwners, usePagedList, useSearch } from '@/lib/hooks';
import type { CustomModule } from '@/lib/modules';

/** 模块详情（含字段）/ module with fields */
interface ModuleDetail extends CustomModule {
  fields: Omit<CustomFieldDef, 'entity'>[];
}

/** 记录 / record */
interface CustomRecord {
  id: string;
  name: string;
  ownerId: string | null;
  accountId: string | null;
  values: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  owner: { id: string; name: string } | null;
  account: { id: string; name: string } | null;
  module: { id: string; name: string; isActive: boolean };
}

interface FormValues {
  name: string;
  ownerId?: string | null;
  accountId?: string | null;
  custom?: Record<string, unknown>;
}

/** 列表中显示的字段数 / fields shown as list columns */
const LIST_FIELDS = 4;

/** 列表中的字段值 / a field value in the list */
function cell(d: Omit<CustomFieldDef, 'entity'>, v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (d.type === 'CHECKBOX') return v ? t('common.yes') : t('common.no');
  return String(v);
}

/**
 * 某个模块的记录列表、表单与详情。
 * Records list, form and detail of one module.
 */
function ModuleRecords({ moduleId }: { moduleId: string }) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const owners = useOwners();
  const search = useSearch();
  const [mod, setMod] = useState<ModuleDetail | null | 'missing'>(null);
  const [ownerId, setOwnerId] = useState<string>();
  const [editing, setEditing] = useState<CustomRecord | 'new' | null>(null);
  const [detail, setDetail] = useState<CustomRecord | null>(null);
  const [form] = Form.useForm<FormValues>();
  const { data, loading, reload, pagination } = usePagedList<CustomRecord>('/api/custom-records', { moduleId, q: search.q, ownerId });

  useEffect(() => {
    api<ModuleDetail>(`/api/custom-modules/${moduleId}`)
      .then(setMod)
      .catch(() => setMod('missing'));
  }, [moduleId]);

  const defs = useMemo(() => (mod && mod !== 'missing' ? mod.fields.filter((f) => f.isActive) : []), [mod]);
  const active = mod !== null && mod !== 'missing' && mod.isActive;

  const openDetail = useCallback(
    (id: string) => {
      api<CustomRecord>(`/api/custom-records/${id}`)
        .then(setDetail)
        .catch((err: Error) => message.error(err.message));
    },
    [message],
  );
  useOpenFromUrl(openDetail);

  const open = (r: CustomRecord | 'new') => {
    form.resetFields();
    form.setFieldsValue(r === 'new' ? { name: '', ownerId: perm.meId, accountId: null, custom: {} } : { name: r.name, ownerId: r.ownerId, accountId: r.accountId, custom: r.values });
    setEditing(r);
  };

  const save = async () => {
    const v = await form.validateFields();
    // 只提交启用字段的值（停用字段不能填写）/ send active fields only (inactive ones are read-only)
    const custom = Object.fromEntries(defs.map((d) => [d.key, v.custom?.[d.key] ?? null]));
    const body = { name: v.name, ownerId: v.ownerId ?? null, accountId: v.accountId ?? null, custom };
    try {
      const saved =
        editing === 'new'
          ? await api<CustomRecord>('/api/custom-records', { method: 'POST', body: { moduleId, ...body } })
          : await api<CustomRecord>(`/api/custom-records/${(editing as CustomRecord).id}`, { method: 'PATCH', body: perm.canAssign ? body : { ...body, ownerId: undefined } });
      message.success(t('common.saved'));
      setEditing(null);
      if (detail?.id === saved.id) setDetail(saved);
      void reload();
    } catch (err) {
      const d = err instanceof ClientApiError ? err.details : undefined;
      if (d?.record?.[0] === 'stale') message.error(t('modules.stale'));
      else if (d?.module?.[0] === 'inactive') message.error(t('modules.inactive'));
      else if (d) form.setFields(toFormErrors(d));
      else message.error((err as Error).message);
    }
  };

  const remove = async (r: CustomRecord) => {
    try {
      await api(`/api/custom-records/${r.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      if (detail?.id === r.id) setDetail(null);
      void reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  if (mod === 'missing') return <Result status="404" title={t('modules.notFound')} />;
  const listFields = defs.slice(0, LIST_FIELDS);

  return (
    <Card
      title={mod?.name ?? ''}
      extra={
        perm.canCreate &&
        active && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')} data-testid="record-new">
            {t('modules.newRecord')}
          </Button>
        )
      }
    >
      {mod && !mod.isActive && <Alert type="warning" showIcon title={t('modules.inactive')} style={{ marginBottom: 16 }} />}
      {mod?.description && <Typography.Paragraph type="secondary">{mod.description}</Typography.Paragraph>}
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search placeholder={t('modules.search')} allowClear {...search.inputProps} style={{ width: 240 }} />
        <Select allowClear placeholder={t('common.owner')} style={{ width: 180 }} value={ownerId} onChange={setOwnerId} options={owners.map((u) => ({ value: u.id, label: u.name }))} aria-label={t('common.owner')} />
      </Space>
      <Table<CustomRecord>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('modules.recordsEmpty') }}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        columns={[
          {
            title: t('modules.recordName'),
            render: (_, r) => (
              <Button type="link" style={{ padding: 0 }} onClick={() => setDetail(r)}>
                {r.name}
              </Button>
            ),
          },
          ...listFields.map((d) => ({ key: d.key, title: d.label, render: (_: unknown, r: CustomRecord) => cell(d, r.values[d.key]) })),
          { title: t('modules.account'), render: (_, r) => (r.account ? <Link href={`/accounts?id=${r.account.id}`}>{r.account.name}</Link> : '—') },
          { title: t('common.owner'), render: (_, r) => r.owner?.name ?? t('common.unassigned') },
          { title: t('common.updatedAt'), render: (_, r) => fmtDateTime(r.updatedAt) },
          {
            title: t('common.actions'),
            render: (_, r) => (
              <Space>
                {active && perm.canEdit(r) && (
                  <Button type="link" size="small" onClick={() => open(r)}>
                    {t('common.edit')}
                  </Button>
                )}
                {perm.canDelete && (
                  <Popconfirm title={t('modules.confirmDeleteRecord', { name: r.name })} onConfirm={() => void remove(r)}>
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
      {/* 从详情抽屉中编辑时，弹窗须在抽屉之上 / when editing from the detail drawer the dialog must sit above it */}
      <Modal title={editing === 'new' ? t('modules.newRecord') : t('modules.editRecord')} open={editing !== null} onOk={save} onCancel={() => setEditing(null)} okText={t('common.save')} cancelText={t('common.cancel')} forceRender zIndex={1100}>
        <Form form={form} name="custom-record" layout="vertical">
          <Form.Item name="name" label={t('modules.recordName')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('modules.recordName') }) }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="ownerId" label={t('common.owner')} extra={perm.canAssign ? undefined : t('common.ownerLocked')}>
            <Select allowClear={perm.canAssign} disabled={!perm.canAssign} options={owners.map((u) => ({ value: u.id, label: u.name }))} />
          </Form.Item>
          <Form.Item name="accountId" label={t('modules.account')}>
            <RecordSelect resource="/api/accounts" initialLabel={editing && editing !== 'new' ? editing.account?.name : undefined} />
          </Form.Item>
          <CustomFieldItems defs={defs as CustomFieldDef[]} />
        </Form>
      </Modal>
      <Drawer title={t('modules.detail')} open={!!detail} onClose={() => setDetail(null)} size={720} destroyOnHidden>
        {detail && (
          <>
            <Descriptions column={2} bordered size="small">
              <Descriptions.Item label={t('modules.recordName')} span={2}>
                {detail.name}
              </Descriptions.Item>
              <Descriptions.Item label={t('modules.module')}>{detail.module.name}</Descriptions.Item>
              <Descriptions.Item label={t('common.owner')}>{detail.owner?.name ?? t('common.unassigned')}</Descriptions.Item>
              <Descriptions.Item label={t('modules.account')} span={2}>
                {detail.account ? <Link href={`/accounts?id=${detail.account.id}`}>{detail.account.name}</Link> : '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('common.createdAt')}>{fmtDateTime(detail.createdAt)}</Descriptions.Item>
              <Descriptions.Item label={t('common.updatedAt')}>{fmtDateTime(detail.updatedAt)}</Descriptions.Item>
            </Descriptions>
            <CustomFieldValues defs={defs as CustomFieldDef[]} values={detail.values} />
            {active && perm.canEdit(detail) && (
              <Button style={{ marginTop: 16 }} onClick={() => open(detail)}>
                {t('common.edit')}
              </Button>
            )}
          </>
        )}
      </Drawer>
    </Card>
  );
}

/**
 * 读取地址中的模块 ID（换模块时重新挂载）。
 * Read the module id from the URL (remount on change).
 */
function ModulesPageInner() {
  const m = useSearchParams().get('m');
  if (!m) return <Result status="404" title={t('modules.notFound')} />;
  return <ModuleRecords key={m} moduleId={m} />;
}

export default function ModulesPage() {
  return (
    <Suspense>
      <ModulesPageInner />
    </Suspense>
  );
}
