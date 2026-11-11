/**
 * 客户详情中的联系人管理（新增、编辑、删除、设为主要联系人）。
 * Contact management inside the account detail (create, edit, delete, set primary).
 */
'use client';

import { useState } from 'react';
import { App, Button, Checkbox, Form, Input, Modal, Popconfirm, Space, Table, Tag } from 'antd';
import { PlusOutlined, StarFilled } from '@ant-design/icons';
import { t } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { toFormErrors } from '@/lib/hooks';
import type { Contact } from '@/lib/types';

interface Props {
  accountId: string;
  /** 是否可编辑（按客户编辑权限）/ editable per account edit rights */
  editable: boolean;
  contacts: Contact[];
  onChanged: () => void;
}

export function ContactsPanel({ accountId, editable, contacts, onChanged }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [saving, setSaving] = useState(false);

  const openForm = (c: Contact | 'new') => {
    form.resetFields();
    if (c !== 'new') form.setFieldsValue(c);
    setEditing(c);
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing === 'new') await api(`/api/accounts/${accountId}/contacts`, { method: 'POST', body: values });
      else await api(`/api/contacts/${(editing as Contact).id}`, { method: 'PATCH', body: values });
      message.success(t('common.saved'));
      setEditing(null);
      onChanged();
    } catch (err) {
      if (err instanceof ClientApiError) form.setFields(toFormErrors(err.details));
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: Contact) => {
    try {
      await api(`/api/contacts/${c.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      onChanged();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <div data-testid="contacts-panel">
      {editable && (
        <Button icon={<PlusOutlined />} onClick={() => openForm('new')} style={{ marginBottom: 12 }}>
          {t('contacts.new')}
        </Button>
      )}
      <Table<Contact>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={contacts}
        locale={{ emptyText: t('common.empty') }}
        columns={[
          {
            title: t('contacts.name'),
            dataIndex: 'name',
            render: (v: string, r) => (
              <Space>
                {v}
                {r.isPrimary && (
                  <Tag icon={<StarFilled />} color="gold">
                    {t('contacts.isPrimary')}
                  </Tag>
                )}
              </Space>
            ),
          },
          { title: t('contacts.title'), dataIndex: 'title' },
          { title: t('contacts.phone'), dataIndex: 'phone' },
          { title: t('contacts.email'), dataIndex: 'email' },
          {
            title: t('common.actions'),
            hidden: !editable,
            render: (_, r) => (
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
      <Modal
        title={editing === 'new' ? t('contacts.new') : t('contacts.edit')}
        open={editing !== null}
        onOk={save}
        onCancel={() => setEditing(null)}
        confirmLoading={saving}
        okText={t('common.save')}
        forceRender
        zIndex={1100}
      >
        <Form form={form} name="contact" layout="vertical" initialValues={{ isPrimary: false }}>
          <div className="form-row">
            <Form.Item
              name="name"
              label={t('contacts.name')}
              rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('contacts.name') }) }]}
            >
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="title" label={t('contacts.title')}>
              <Input maxLength={100} />
            </Form.Item>
          </div>
          <div className="form-row">
            <Form.Item name="phone" label={t('contacts.phone')}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="email" label={t('contacts.email')} rules={[{ type: 'email', message: t('common.invalidEmail') }]}>
              <Input maxLength={254} />
            </Form.Item>
          </div>
          <Form.Item name="isPrimary" valuePropName="checked">
            <Checkbox>{t('contacts.isPrimary')}</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
