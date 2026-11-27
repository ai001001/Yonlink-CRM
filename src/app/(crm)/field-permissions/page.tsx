/**
 * 字段权限页（设置 › 字段权限，需 user.manage）：选对象与角色，逐个字段设为可编辑、只读或隐藏，按角色整体保存。
 * 标准字段只列出可限制的；自定义字段全部列出（含已停用）。系统管理员不受限，不在角色中。
 * Field permissions (Setup › Field permissions, user.manage): pick a module and a role, set each field to editable,
 * read-only or hidden and save the role's settings as a whole. Only restrictable standard fields are listed; every
 * custom field is (inactive ones included). Administrators are never restricted and are not listed.
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Radio, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { STANDARD_FIELD_LABEL, type FieldEntity } from '@/lib/field-access';

type Access = 'EDIT' | 'READ_ONLY' | 'HIDDEN';
interface FieldRow {
  field: string;
  custom: boolean;
  label?: string;
  isActive?: boolean;
  required?: boolean;
}
interface RoleRow {
  key: string;
  role?: 'MANAGER' | 'SALES' | 'READONLY';
  customRoleId?: string;
  name?: string;
  baseRole?: string;
}
interface Settings {
  fields: FieldRow[];
  roles: RoleRow[];
  rules: Record<string, Record<string, Exclude<Access, 'EDIT'>>>;
}

const ENTITIES: FieldEntity[] = ['LEAD', 'ACCOUNT', 'CONTACT', 'DEAL'];
const ACCESS: Access[] = ['EDIT', 'READ_ONLY', 'HIDDEN'];

/** 角色显示名 / role display name */
const roleName = (r: RoleRow) => (r.role ? tEnum('role', r.role) : `${r.name} · ${t('roles.basedOn', { role: tEnum('role', r.baseRole ?? '') })}`);

export default function FieldPermissionsPage() {
  const { message } = App.useApp();
  const [entity, setEntity] = useState<FieldEntity>('LEAD');
  const [roleKey, setRoleKey] = useState<string>('SALES');
  const [data, setData] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Record<string, Access>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api<Settings>(`/api/field-permissions?entity=${entity}`)
      .then(setData)
      .catch((err: unknown) => message.error((err as Error).message));
  }, [entity, message]);
  useEffect(load, [load]);

  // 当前角色已保存的设置 / the selected role's saved settings
  const saved = useMemo(() => {
    const rules = data?.rules[roleKey] ?? {};
    return Object.fromEntries((data?.fields ?? []).map((f) => [f.field, (rules[f.field] ?? 'EDIT') as Access]));
  }, [data, roleKey]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(saved);
  }, [saved]);
  const dirty = Object.keys(saved).some((f) => saved[f] !== draft[f]);
  const role = data?.roles.find((r) => r.key === roleKey);

  const save = async () => {
    if (!role) return;
    setSaving(true);
    try {
      await api('/api/field-permissions', { method: 'PUT', body: { entity, ...(role.role ? { role: role.role } : { customRoleId: role.customRoleId }), rules: draft } });
      message.success(t('common.saved'));
      load();
    } catch (err) {
      message.error(err instanceof ClientApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const label = (f: FieldRow) => (f.custom ? f.label : t(STANDARD_FIELD_LABEL[entity][f.field] ?? ('common.description' as MessageKey)));
  const restricted = Object.values(draft).filter((a) => a !== 'EDIT').length;

  return (
    <Card title={t('fieldPerms.title')}>
      <Typography.Paragraph type="secondary">{t('fieldPerms.hint')}</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented
          value={entity}
          onChange={(v) => setEntity(v as FieldEntity)}
          options={ENTITIES.map((e) => ({ value: e, label: t(`customFields.entity.${e}` as MessageKey) }))}
          data-testid="field-perm-entity"
        />
        <Select
          style={{ minWidth: 240 }}
          value={roleKey}
          onChange={setRoleKey}
          aria-label={t('fieldPerms.role')}
          data-testid="field-perm-role"
          options={[
            { label: t('roles.systemGroup'), options: (data?.roles ?? []).filter((r) => r.role).map((r) => ({ value: r.key, label: roleName(r) })) },
            ...((data?.roles ?? []).some((r) => !r.role) ? [{ label: t('roles.customGroup'), options: (data?.roles ?? []).filter((r) => !r.role).map((r) => ({ value: r.key, label: roleName(r) })) }] : []),
          ]}
        />
        <Tag>{t('fieldPerms.restricted', { n: restricted })}</Tag>
      </Space>
      {dirty && <Alert type="warning" showIcon title={t('fieldPerms.unsaved')} style={{ marginBottom: 12 }} />}
      <Table<FieldRow>
        rowKey="field"
        size="small"
        pagination={false}
        loading={!data}
        dataSource={data?.fields ?? []}
        scroll={{ x: 'max-content' }}
        data-testid="field-perm-table"
        columns={[
          {
            title: t('fieldPerms.field'),
            render: (_, f) => (
              <Space wrap>
                <span>{label(f)}</span>
                {f.custom && <Tag>{t('fieldPerms.custom')}</Tag>}
                {f.custom && f.isActive === false && <Tag color="default">{t('fieldPerms.inactive')}</Tag>}
                {f.required && <Typography.Text type="secondary">{t('fieldPerms.required')}</Typography.Text>}
              </Space>
            ),
          },
          {
            title: t('fieldPerms.access'),
            render: (_, f) => (
              <Radio.Group
                value={draft[f.field] ?? 'EDIT'}
                onChange={(e) => setDraft((d) => ({ ...d, [f.field]: e.target.value as Access }))}
                optionType="button"
                buttonStyle="solid"
                size="small"
                aria-label={label(f)}
                data-testid={`field-perm-${f.field}`}
                options={ACCESS.map((a) => ({ value: a, label: t(`fieldPerms.${a}` as MessageKey) }))}
              />
            ),
          },
        ]}
      />
      <Space style={{ marginTop: 16 }}>
        <Button type="primary" onClick={() => void save()} loading={saving} disabled={!dirty} data-testid="field-perm-save">
          {t('common.save')}
        </Button>
        <Button onClick={() => setDraft(saved)} disabled={!dirty}>
          {t('common.cancel')}
        </Button>
      </Space>
    </Card>
  );
}
