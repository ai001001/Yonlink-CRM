/**
 * 商机详情的“联系人角色”页签：从商机客户的联系人中添加角色（决策人、评估人等），可设一个主要联系人。
 * Deal "Contact roles" tab: give contacts of the deal's account a role (decision maker, evaluator, …), one may be primary.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, App, Button, Checkbox, Form, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { usePermissions } from './AuthProvider';

/** 角色取值（与服务端一致）/ role values (same as the server) */
export const CONTACT_ROLES = ['DECISION_MAKER', 'EVALUATOR', 'INFLUENCER', 'TECHNICAL_BUYER', 'PURCHASING', 'END_USER', 'OTHER'] as const;

/** 联系人角色 / Contact role */
interface ContactRole {
  id: string;
  contactId: string;
  role: string;
  isPrimary: boolean;
  contact: { id: string; name: string; title: string | null; phone: string | null; email: string | null };
}

interface Props {
  deal: { id: string; ownerId: string | null; accountId: string };
}

interface AddForm {
  contactId?: string;
  role?: string;
  isPrimary?: boolean;
}

/**
 * 角色相关错误提示。
 * Messages for contact-role errors.
 */
function roleError(err: unknown): string {
  const d = err instanceof ClientApiError ? err.details : undefined;
  const code = d?.contactId?.[0] ?? (d?.isPrimary?.[0] ? 'primary_conflict' : undefined);
  return code ? t(`contactRoles.error.${code}` as MessageKey) : (err as Error).message;
}

const roleOptions = () => CONTACT_ROLES.map((r) => ({ value: r, label: tEnum('dealContactRole', r) }));

export function DealContactRolesPanel({ deal }: Props) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const editable = perm.canEdit(deal);
  const [roles, setRoles] = useState<ContactRole[]>([]);
  const [contacts, setContacts] = useState<{ id: string; name: string; title: string | null }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [form] = Form.useForm<AddForm>();

  const load = useCallback(async () => {
    try {
      const r = await api<{ roles: ContactRole[]; contacts: { id: string; name: string; title: string | null }[] }>(`/api/deals/${deal.id}/contact-roles`);
      setRoles(r.roles);
      setContacts(r.contacts);
      setLoaded(true);
    } catch (err) {
      message.error((err as Error).message);
    }
  }, [deal.id, message]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const add = async () => {
    const v = await form.validateFields();
    try {
      await api(`/api/deals/${deal.id}/contact-roles`, { method: 'POST', body: { contactId: v.contactId, role: v.role, isPrimary: !!v.isPrimary } });
      message.success(t('common.saved'));
      form.resetFields();
      void load();
    } catch (err) {
      message.error(roleError(err));
    }
  };

  const patch = async (r: ContactRole, body: { role?: string; isPrimary?: boolean }) => {
    try {
      await api(`/api/deal-contact-roles/${r.id}`, { method: 'PATCH', body });
      message.success(t('common.saved'));
      void load();
    } catch (err) {
      message.error(roleError(err));
    }
  };

  const remove = async (r: ContactRole) => {
    try {
      await api(`/api/deal-contact-roles/${r.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      void load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <div data-testid="deal-contact-roles">
      {editable && loaded && contacts.length === 0 && roles.length === 0 && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }} title={t('contactRoles.noContacts')} action={<Link href={`/accounts?id=${deal.accountId}`}>{t('contactRoles.openAccount')}</Link>} />
      )}
      {editable && contacts.length > 0 && (
        <Form form={form} name="add-contact-role" layout="inline" initialValues={{ role: 'DECISION_MAKER' }} style={{ marginBottom: 12, rowGap: 8 }}>
          <Form.Item name="contactId" label={t('contactRoles.contact')} rules={[{ required: true, message: t('common.required', { field: t('contactRoles.contact') }) }]}>
            <Select
              style={{ minWidth: 200 }}
              popupMatchSelectWidth={false}
              showSearch={{ optionFilterProp: 'label' }}
              placeholder={t('contactRoles.selectContact')}
              options={contacts.map((c) => ({ value: c.id, label: c.title ? `${c.name}${t('common.parens', { text: c.title })}` : c.name }))}
            />
          </Form.Item>
          <Form.Item name="role" label={t('contactRoles.role')}>
            <Select style={{ width: 140 }} options={roleOptions()} />
          </Form.Item>
          <Form.Item name="isPrimary" valuePropName="checked">
            <Checkbox>{t('contactRoles.primary')}</Checkbox>
          </Form.Item>
          <Button type="primary" icon={<PlusOutlined />} onClick={add}>
            {t('contactRoles.add')}
          </Button>
        </Form>
      )}
      <Table<ContactRole>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={roles}
        locale={{ emptyText: t('common.empty') }}
        columns={[
          {
            title: t('contactRoles.contact'),
            render: (_, r) => (
              <Space size={4}>
                <Typography.Text>{r.contact.name}</Typography.Text>
                {r.contact.title && <Typography.Text type="secondary">{r.contact.title}</Typography.Text>}
                {r.isPrimary && <Tag color="gold">{t('contactRoles.primary')}</Tag>}
              </Space>
            ),
          },
          {
            title: t('contactRoles.role'),
            width: 160,
            render: (_, r) =>
              editable ? (
                <Select aria-label={`${t('contactRoles.role')} ${r.contact.name}`} size="small" style={{ width: 140 }} value={r.role} options={roleOptions()} onChange={(role: string) => patch(r, { role })} />
              ) : (
                tEnum('dealContactRole', r.role)
              ),
          },
          { title: t('contacts.phone'), render: (_, r) => r.contact.phone },
          { title: t('contacts.email'), render: (_, r) => r.contact.email },
          {
            title: t('common.actions'),
            hidden: !editable,
            render: (_, r) => (
              <Space>
                {!r.isPrimary && (
                  <Button type="link" size="small" onClick={() => patch(r, { isPrimary: true })}>
                    {t('contactRoles.setPrimary')}
                  </Button>
                )}
                <Popconfirm title={t('contactRoles.confirmRemove')} onConfirm={() => remove(r)}>
                  <Button type="link" size="small" danger aria-label={`${t('contactRoles.remove')} ${r.contact.name}`}>
                    {t('contactRoles.remove')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </div>
  );
}
