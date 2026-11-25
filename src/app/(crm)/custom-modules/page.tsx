/**
 * 自定义模块设置页（设置 › 自定义模块，需 customfield.manage）：列出模块（名称、说明、字段数、记录数、启用），
 * 新建、编辑、启停、删除（有记录时不能删除），在抽屉中管理模块的字段。
 * Custom module setup (Setup › Custom modules, customfield.manage): modules with name, description, field and record
 * counts and active flag; create, edit, toggle and delete (not while records exist); fields are managed in a drawer.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { App, Button, Card, Drawer, Form, Input, Modal, Popconfirm, Space, Switch, Table, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { FieldManager } from '@/components/FieldManager';
import { t } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { notifyModulesChanged, type CustomModule } from '@/lib/modules';

interface FormValues {
  name: string;
  description?: string;
}

export default function CustomModulesPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<CustomModule[]>([]);
  const [editing, setEditing] = useState<CustomModule | 'new' | null>(null);
  const [fieldsOf, setFieldsOf] = useState<CustomModule | null>(null);
  const openNewField = useRef<() => void>(undefined);
  const [form] = Form.useForm<FormValues>();

  const load = useCallback(() => {
    api<{ items: CustomModule[] }>('/api/custom-modules')
      .then((r) => setRows(r.items))
      .catch((err: Error) => message.error(err.message));
  }, [message]);
  useEffect(load, [load]);

  const open = (m: CustomModule | 'new') => {
    form.resetFields();
    form.setFieldsValue(m === 'new' ? { name: '', description: '' } : { name: m.name, description: m.description ?? '' });
    setEditing(m);
  };

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) message.success(ok);
      load();
      notifyModulesChanged();
      return true;
    } catch (err) {
      const d = err instanceof ClientApiError ? err.details : undefined;
      if (d?.name?.[0] === 'taken') form.setFields([{ name: 'name', errors: [t('modules.taken')] }]);
      else if (d?.name?.[0] === 'limit_reached') message.error(t('modules.limit'));
      else if (d?.module?.[0] === 'has_records') message.error(t('modules.hasRecords'));
      else message.error((err as Error).message);
      return false;
    }
  };

  const save = async () => {
    const v = await form.validateFields();
    const body = { name: v.name, description: v.description || null };
    const ok = await run(() => (editing === 'new' ? api('/api/custom-modules', { method: 'POST', body }) : api(`/api/custom-modules/${(editing as CustomModule).id}`, { method: 'PATCH', body })), t('common.saved'));
    if (ok) setEditing(null);
  };

  return (
    <Card
      title={t('modules.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')} data-testid="module-new">
          {t('modules.new')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">{t('modules.hint')}</Typography.Paragraph>
      <Table<CustomModule>
        rowKey="id"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('modules.empty') }}
        columns={[
          { title: t('modules.name'), render: (_, r) => (r.isActive ? <Link href={`/modules?m=${r.id}`}>{r.name}</Link> : r.name) },
          { title: t('modules.description'), render: (_, r) => r.description ?? '—' },
          { title: t('modules.fieldCount'), render: (_, r) => r._count?.fields ?? 0 },
          { title: t('modules.recordCount'), render: (_, r) => r._count?.records ?? 0 },
          {
            title: t('modules.active'),
            render: (_, r) => <Switch size="small" checked={r.isActive} aria-label={`${t('modules.active')} ${r.name}`} onChange={(v) => void run(() => api(`/api/custom-modules/${r.id}`, { method: 'PATCH', body: { isActive: v } }))} />,
          },
          {
            title: t('common.actions'),
            render: (_, r) => (
              <Space>
                <Button type="link" size="small" onClick={() => setFieldsOf(r)}>
                  {t('modules.manageFields')}
                </Button>
                <Button type="link" size="small" onClick={() => open(r)}>
                  {t('common.edit')}
                </Button>
                <Popconfirm title={t('modules.confirmDelete', { name: r.name })} onConfirm={() => void run(() => api(`/api/custom-modules/${r.id}`, { method: 'DELETE' }), t('common.deleted'))}>
                  <Button type="link" size="small" danger>
                    {t('common.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal title={editing === 'new' ? t('modules.new') : t('modules.edit')} open={editing !== null} onOk={save} onCancel={() => setEditing(null)} okText={t('common.save')} cancelText={t('common.cancel')} forceRender>
        <Form form={form} name="custom-module" layout="vertical">
          <Form.Item name="name" label={t('modules.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('modules.name') }) }]}>
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item name="description" label={t('modules.description')}>
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        title={fieldsOf ? t('modules.fieldsOf', { name: fieldsOf.name }) : ''}
        open={!!fieldsOf}
        onClose={() => setFieldsOf(null)}
        size={860}
        destroyOnHidden
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openNewField.current?.()} data-testid="module-field-new">
            {t('customFields.new')}
          </Button>
        }
      >
        {fieldsOf && (
          <FieldManager
            listUrl={`/api/custom-modules/${fieldsOf.id}/fields`}
            createUrl={`/api/custom-modules/${fieldsOf.id}/fields`}
            itemUrl={(id) => `/api/custom-module-fields/${id}`}
            onReady={(fn) => {
              openNewField.current = fn;
            }}
            onChanged={load}
          />
        )}
      </Drawer>
    </Card>
  );
}
