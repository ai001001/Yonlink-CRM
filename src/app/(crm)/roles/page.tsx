/**
 * 角色与权限页（设置 › 角色与权限，需 user.manage）：系统角色的权限只读展示；自定义角色可新建（选基础角色并按其权限预填）、
 * 修改名称、说明与权限、删除（无人使用时）。权限按类别分组勾选，只属于系统管理员的权限不能勾选。
 * Roles and permissions (Setup › Roles and permissions, user.manage): system role permissions are read-only; custom
 * roles can be created (choose a base role and prefill from it), renamed, re-described, re-permissioned and deleted
 * (when unused). Permissions are grouped by category; admin-only ones cannot be ticked.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Collapse, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { usePermissions } from '@/components/AuthProvider';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';

type BaseRole = 'MANAGER' | 'SALES' | 'READONLY';
interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  baseRole: BaseRole;
  permissions: string[];
  _count: { users: number };
}
interface Roles {
  system: { role: 'ADMIN' | BaseRole; permissions: string[] }[];
  custom: CustomRole[];
  grantable: string[];
  adminOnly: string[];
}

/** 权限分组（未列出的归入“设置与数据”）/ permission groups (unlisted ones go to setup and data) */
const GROUPS: [string, string[]][] = [
  ['records', ['record.read.all', 'record.create', 'record.update.all', 'record.update.own', 'record.delete', 'owner.assign', 'tag.manage', 'view.share']],
  ['sales', ['forecast.manage', 'campaign.manage', 'quote.approve', 'territory.manage', 'portal.manage']],
  ['automation', ['workflow.manage', 'scoring.manage', 'assignment.manage', 'approval.manage', 'validation.manage', 'cadence.manage', 'blueprint.manage', 'macro.manage']],
  ['inventory', ['product.manage', 'purchase.read', 'purchase.manage', 'rate.manage']],
  ['service', ['sla.manage', 'kb.manage']],
];
const groupOf = (p: string) => GROUPS.find(([, list]) => list.includes(p))?.[0] ?? 'setup';
const permLabel = (p: string) => t(`perm.${p}` as MessageKey);

interface FormValues {
  name: string;
  description?: string;
  baseRole: BaseRole;
  permissions: string[];
}

/** 按分组勾选权限 / grouped permission checkboxes */
function PermissionPicker({ all, adminOnly, value = [], onChange, disabled }: { all: string[]; adminOnly: string[]; value?: string[]; onChange?: (v: string[]) => void; disabled?: boolean }) {
  const groups = ['records', 'sales', 'automation', 'inventory', 'service', 'setup'];
  return (
    <div data-testid="permission-picker">
      {groups.map((g) => {
        const list = [...all, ...adminOnly].filter((p) => groupOf(p) === g);
        if (!list.length) return null;
        return (
          <div key={g} style={{ marginBottom: 8 }}>
            <Typography.Text strong>{t(`roles.group.${g}` as MessageKey)}</Typography.Text>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 4, marginTop: 4 }}>
              {list.map((p) => {
                const locked = adminOnly.includes(p);
                return (
                  <Checkbox
                    key={p}
                    disabled={disabled || locked}
                    checked={value.includes(p)}
                    onChange={(e) => onChange?.(e.target.checked ? [...value, p] : value.filter((x) => x !== p))}
                  >
                    {permLabel(p)}
                    {locked && <Typography.Text type="secondary"> · {t('roles.adminOnly')}</Typography.Text>}
                  </Checkbox>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function RolesPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const [data, setData] = useState<Roles | null>(null);
  const [editing, setEditing] = useState<CustomRole | 'new' | null>(null);
  const [form] = Form.useForm<FormValues>();

  const load = useCallback(() => {
    api<Roles>('/api/roles')
      .then(setData)
      .catch((err: Error) => message.error(err.message));
  }, [message]);
  useEffect(() => {
    if (perm.can('user.manage')) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  if (!perm.can('user.manage')) return <Alert type="warning" showIcon title={t('error.FORBIDDEN')} />;
  if (!data) return null;
  const systemOf = (role: string) => data.system.find((s) => s.role === role)?.permissions ?? [];

  const open = (r: CustomRole | 'new') => {
    form.resetFields();
    form.setFieldsValue(r === 'new' ? { name: '', description: '', baseRole: 'SALES', permissions: systemOf('SALES').filter((p) => data.grantable.includes(p)) } : { name: r.name, description: r.description ?? '', baseRole: r.baseRole, permissions: r.permissions });
    setEditing(r);
  };
  const handle = (err: unknown) => {
    const d = err instanceof ClientApiError ? err.details : undefined;
    if (d?.name?.[0] === 'taken') form.setFields([{ name: 'name', errors: [t('roles.taken')] }]);
    else if (d?.name?.[0] === 'limit_reached') message.error(t('roles.limit'));
    else if (d?.role?.[0] === 'in_use') message.error(t('roles.inUse'));
    else message.error((err as Error).message);
  };
  const save = async () => {
    const v = await form.validateFields();
    try {
      if (editing === 'new') await api('/api/roles', { method: 'POST', body: { name: v.name, description: v.description || null, baseRole: v.baseRole, permissions: v.permissions } });
      else await api(`/api/roles/${(editing as CustomRole).id}`, { method: 'PATCH', body: { name: v.name, description: v.description || null, permissions: v.permissions } });
      message.success(t('common.saved'));
      setEditing(null);
      load();
    } catch (err) {
      handle(err);
    }
  };
  const remove = async (r: CustomRole) => {
    try {
      await api(`/api/roles/${r.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      load();
    } catch (err) {
      handle(err);
    }
  };

  return (
    <Card
      title={t('roles.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')} data-testid="role-new">
          {t('roles.new')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">{t('roles.hint')}</Typography.Paragraph>
      <Typography.Title level={5}>{t('roles.custom')}</Typography.Title>
      <Table<CustomRole>
        rowKey="id"
        dataSource={data.custom}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('roles.empty') }}
        style={{ marginBottom: 24 }}
        columns={[
          { title: t('roles.name'), render: (_, r) => r.name },
          { title: t('roles.baseRole'), render: (_, r) => tEnum('role', r.baseRole) },
          { title: t('roles.permissions'), render: (_, r) => t('roles.permissionCount', { n: r.permissions.length }) },
          { title: t('roles.users'), render: (_, r) => r._count.users },
          { title: t('roles.description'), render: (_, r) => r.description ?? '—' },
          {
            title: t('common.actions'),
            render: (_, r) => (
              <Space>
                <Button type="link" size="small" onClick={() => open(r)}>
                  {t('common.edit')}
                </Button>
                <Popconfirm title={t('roles.confirmDelete', { name: r.name })} onConfirm={() => void remove(r)}>
                  <Button type="link" size="small" danger>
                    {t('common.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Typography.Title level={5}>{t('roles.system')}</Typography.Title>
      <Collapse
        data-testid="system-roles"
        items={data.system.map((s) => ({
          key: s.role,
          label: (
            <Space>
              {tEnum('role', s.role)}
              <Tag>{t('roles.permissionCount', { n: s.permissions.length })}</Tag>
            </Space>
          ),
          children: <PermissionPicker all={data.grantable} adminOnly={data.adminOnly} value={s.permissions} disabled />,
        }))}
      />
      <Modal title={editing === 'new' ? t('roles.new') : t('roles.edit')} open={editing !== null} onOk={save} onCancel={() => setEditing(null)} okText={t('common.save')} cancelText={t('common.cancel')} width={760} forceRender>
        <Form form={form} name="role" layout="vertical">
          <div className="form-row">
            <Form.Item name="name" label={t('roles.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('roles.name') }) }]}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="baseRole" label={t('roles.baseRole')} extra={editing === 'new' ? t('roles.fromBase') : undefined}>
              <Select
                disabled={editing !== 'new'}
                options={(['MANAGER', 'SALES', 'READONLY'] as const).map((r) => ({ value: r, label: tEnum('role', r) }))}
                onChange={(r: BaseRole) => form.setFieldValue('permissions', systemOf(r).filter((p) => data.grantable.includes(p)))}
              />
            </Form.Item>
          </div>
          <Form.Item name="description" label={t('roles.description')}>
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
          <Form.Item name="permissions" label={t('roles.permissions')}>
            <PermissionPicker all={data.grantable} adminOnly={data.adminOnly} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
