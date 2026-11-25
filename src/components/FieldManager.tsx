/**
 * 字段管理表格与编辑弹窗（自定义字段页与自定义模块的字段共用）：列出字段（名称、键、类型、选项、必填、启用），
 * 新建、编辑、启停、删除。新建按钮由使用方放置，通过 ref 风格的 onReady 取得打开方法。
 * Field table and editor shared by the custom fields page and custom module fields: label, key, type, options,
 * required and active with create, edit, toggle and delete. The caller places the create button and receives the
 * opener through onReady.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import type { CustomFieldDef } from '@/components/CustomFields';
import { t } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';

const TYPES: CustomFieldDef['type'][] = ['TEXT', 'TEXTAREA', 'NUMBER', 'DATE', 'PICKLIST', 'CHECKBOX', 'URL', 'EMAIL'];

/** 字段（模块字段没有 entity）/ a field (module fields have no entity) */
export type FieldDef = Omit<CustomFieldDef, 'entity'>;

interface FormValues {
  label: string;
  type: CustomFieldDef['type'];
  options: string[];
  required: boolean;
  isActive: boolean;
}

interface Props {
  /** 列表地址 / list URL */
  listUrl: string;
  /** 新建地址 / create URL */
  createUrl: string;
  /** 新建时附加的字段（如 entity）/ extra body fields on create (e.g. entity) */
  createExtra?: Record<string, unknown>;
  /** 单个字段的地址 / URL of one field */
  itemUrl: (id: string) => string;
  /** 取得“新建字段”的打开方法 / receives the opener for "new field" */
  onReady?: (openNew: () => void) => void;
  /** 字段变化后（如更新计数）/ after fields change (e.g. to refresh counts) */
  onChanged?: () => void;
}

export function FieldManager({ listUrl, createUrl, createExtra, itemUrl, onReady, onChanged }: Props) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<FieldDef[]>([]);
  const [editing, setEditing] = useState<FieldDef | 'new' | null>(null);
  const [form] = Form.useForm<FormValues>();
  const type = Form.useWatch('type', form);

  const load = useCallback(() => {
    api<{ items: FieldDef[] }>(listUrl)
      .then((r) => setRows(r.items))
      .catch((err: Error) => message.error(err.message));
  }, [listUrl, message]);
  useEffect(load, [load]);

  const open = useCallback(
    (f: FieldDef | 'new') => {
      form.resetFields();
      form.setFieldsValue(f === 'new' ? { label: '', type: 'TEXT', options: [], required: false, isActive: true } : { label: f.label, type: f.type, options: f.options, required: f.required, isActive: f.isActive });
      setEditing(f);
    },
    [form],
  );
  useEffect(() => onReady?.(() => open('new')), [onReady, open]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) message.success(ok);
      load();
      onChanged?.();
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
        ? api(createUrl, { method: 'POST', body: { ...createExtra, label: v.label, type: v.type, options, required: v.type === 'CHECKBOX' ? false : !!v.required } })
        : api(itemUrl((editing as FieldDef).id), {
            method: 'PATCH',
            body: { label: v.label, required: v.type === 'CHECKBOX' ? false : !!v.required, isActive: v.isActive, ...(v.type === 'PICKLIST' ? { options } : {}) },
          }),
      t('common.saved'),
    );
    if (ok) setEditing(null);
  };

  const remove = (f: FieldDef) =>
    run(async () => {
      const r = await api<{ cleared: number }>(itemUrl(f.id), { method: 'DELETE' });
      message.success(t('customFields.deleted', { n: r.cleared }));
    });

  return (
    <>
      <Table<FieldDef>
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
            render: (_, r) => <Switch size="small" checked={r.isActive} aria-label={`${t('customFields.active')} ${r.label}`} onChange={(v) => void run(() => api(itemUrl(r.id), { method: 'PATCH', body: { isActive: v } }))} />,
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
    </>
  );
}
