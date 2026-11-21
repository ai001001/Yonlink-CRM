/**
 * 自定义字段页（设置 › 自定义字段，需 customfield.manage）：按对象列出字段（名称、类型、选项、必填、启用），新建、编辑、删除。
 * Custom fields page (Setup › Custom fields, customfield.manage): fields per entity (name, type, options, required,
 * active) with create, edit and delete.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { CustomEntity, CustomFieldDef } from '@/components/CustomFields';
import { t } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';

const ENTITIES: CustomEntity[] = ['LEAD', 'ACCOUNT', 'CONTACT', 'DEAL'];
const TYPES: CustomFieldDef['type'][] = ['TEXT', 'TEXTAREA', 'NUMBER', 'DATE', 'PICKLIST', 'CHECKBOX', 'URL', 'EMAIL'];

interface FormValues {
  label: string;
  type: CustomFieldDef['type'];
  options: string[];
  required: boolean;
  isActive: boolean;
}

export default function CustomFieldsPage() {
  const { message } = App.useApp();
  const [entity, setEntity] = useState<CustomEntity>('LEAD');
  const [rows, setRows] = useState<CustomFieldDef[]>([]);
  const [editing, setEditing] = useState<CustomFieldDef | 'new' | null>(null);
  const [form] = Form.useForm<FormValues>();
  const type = Form.useWatch('type', form);

  const load = useCallback(() => {
    api<{ items: CustomFieldDef[] }>(`/api/custom-fields?entity=${entity}`)
      .then((r) => setRows(r.items))
      .catch((err: Error) => message.error(err.message));
  }, [entity, message]);
  useEffect(load, [load]);

  const open = (f: CustomFieldDef | 'new') => {
    form.resetFields();
    form.setFieldsValue(f === 'new' ? { label: '', type: 'TEXT', options: [], required: false, isActive: true } : { label: f.label, type: f.type, options: f.options, required: f.required, isActive: f.isActive });
    setEditing(f);
  };

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) message.success(ok);
      load();
      return true;
    } catch (err) {
      if (err instanceof ClientApiError && err.details?.label?.[0] === 'taken') form.setFields([{ name: 'label', errors: [t('customFields.taken')] }]);
      else message.error((err as Error).message);
      return false;
    }
  };

  const save = async () => {
    const v = await form.validateFields();
    const options = v.type === 'PICKLIST' ? (v.options ?? []) : [];
    const ok = await run(() =>
      editing === 'new'
        ? api('/api/custom-fields', { method: 'POST', body: { entity, label: v.label, type: v.type, options, required: v.type === 'CHECKBOX' ? false : !!v.required } })
        : api(`/api/custom-fields/${(editing as CustomFieldDef).id}`, {
            method: 'PATCH',
            body: { label: v.label, required: v.type === 'CHECKBOX' ? false : !!v.required, isActive: v.isActive, ...(v.type === 'PICKLIST' ? { options } : {}) },
          }),
      t('common.saved'),
    );
    if (ok) setEditing(null);
  };

  const remove = (f: CustomFieldDef) =>
    run(async () => {
      const r = await api<{ cleared: number }>(`/api/custom-fields/${f.id}`, { method: 'DELETE' });
      message.success(t('customFields.deleted', { n: r.cleared }));
    });

  return (
    <Card
      title={t('customFields.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')} data-testid="custom-field-new">
          {t('customFields.new')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">{t('customFields.hint')}</Typography.Paragraph>
      <Segmented style={{ marginBottom: 16 }} value={entity} onChange={(v) => setEntity(v as CustomEntity)} options={ENTITIES.map((e) => ({ value: e, label: t(`customFields.entity.${e}`) }))} />
      <Table<CustomFieldDef>
        rowKey="id"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('customFields.empty') }}
        columns={[
          { title: t('customFields.label'), dataIndex: 'label' },
          { title: t('customFields.key'), render: (_, r) => <Typography.Text code>{r.key}</Typography.Text> },
          { title: t('customFields.type'), render: (_, r) => t(`customFields.type.${r.type}`) },
          { title: t('customFields.options'), render: (_, r) => (r.options.length ? r.options.map((o) => <Tag key={o}>{o}</Tag>) : '—') },
          { title: t('customFields.required'), render: (_, r) => (r.required ? t('common.yes') : t('common.no')) },
          {
            title: t('customFields.active'),
            render: (_, r) => <Switch size="small" checked={r.isActive} aria-label={`${t('customFields.active')} ${r.label}`} onChange={(v) => void run(() => api(`/api/custom-fields/${r.id}`, { method: 'PATCH', body: { isActive: v } }))} />,
          },
          {
            title: t('common.actions'),
            render: (_, r) => (
              <Space>
                <Button type="link" size="small" onClick={() => open(r)}>
                  {t('common.edit')}
                </Button>
                <Popconfirm title={t('customFields.confirmDelete', { label: r.label })} onConfirm={() => void remove(r)}>
                  <Button type="link" size="small" danger>
                    {t('common.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal title={editing === 'new' ? t('customFields.new') : t('customFields.edit')} open={editing !== null} onOk={save} onCancel={() => setEditing(null)} okText={t('common.save')} cancelText={t('common.cancel')} forceRender>
        <Form form={form} name="custom-field" layout="vertical">
          <Form.Item name="label" label={t('customFields.label')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('customFields.label') }) }]}>
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item name="type" label={t('customFields.type')}>
            <Select disabled={editing !== 'new'} options={TYPES.map((x) => ({ value: x, label: t(`customFields.type.${x}`) }))} />
          </Form.Item>
          {type === 'PICKLIST' && (
            <Form.Item name="options" label={t('customFields.options')} extra={t('customFields.optionsHint')} rules={[{ required: true, message: t('common.required', { field: t('customFields.options') }) }]}>
              <Select mode="tags" maxCount={50} open={false} aria-label={t('customFields.options')} />
            </Form.Item>
          )}
          {type !== 'CHECKBOX' && (
            <Form.Item name="required" label={t('customFields.required')} valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
          {editing !== 'new' && (
            <Form.Item name="isActive" label={t('customFields.active')} valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Card>
  );
}
