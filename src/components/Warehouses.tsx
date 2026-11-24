/**
 * 仓库的共用界面：读取仓库、仓库下拉（默认仓库在前、停用仓库不可选）、仓库管理弹窗（产品页的“仓库”按钮）。
 * Shared warehouse UI: loading warehouses, the warehouse picker (default first, inactive ones disabled) and the
 * warehouse management dialog (the "Warehouses" button on the products page).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { t, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';

/** 仓库 / warehouse */
export interface Warehouse {
  id: string;
  code: string;
  name: string;
  address: string | null;
  isActive: boolean;
  isDefault: boolean;
  products: number;
  units: string;
}

/**
 * 读取仓库（默认仓库在前）。
 * Load warehouses (default first).
 */
export function useWarehouses() {
  const [items, setItems] = useState<Warehouse[]>([]);
  const reload = useCallback(() => {
    api<{ items: Warehouse[] }>('/api/warehouses')
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);
  useEffect(reload, [reload]);
  return { items, reload };
}

/** 仓库显示名 / warehouse label */
export const warehouseLabel = (w: Pick<Warehouse, 'code' | 'name'>) => `${w.code} · ${w.name}`;

/**
 * 仓库下拉（停用的仓库不可选；默认仓库标注）。
 * Warehouse picker (inactive ones disabled; the default marked).
 */
export function WarehouseSelect({ items, value, onChange, ...rest }: { items: Warehouse[]; value?: string; onChange?: (v?: string) => void; 'aria-label'?: string; style?: React.CSSProperties; allowClear?: boolean; placeholder?: string }) {
  return (
    <Select
      {...rest}
      value={value}
      onChange={onChange}
      options={items.map((w) => ({ value: w.id, disabled: !w.isActive, label: `${warehouseLabel(w)}${w.isDefault ? ` · ${t('warehouses.default')}` : ''}${w.isActive ? '' : ` · ${t('warehouses.inactiveTag')}`}` }))}
    />
  );
}

/** 服务端错误代码 → 提示 / server error codes → messages */
const ERRORS: Record<string, MessageKey> = {
  taken: 'warehouses.taken',
  need_default: 'warehouses.needDefault',
  default_must_be_active: 'warehouses.defaultActive',
  has_movements: 'warehouses.hasMovements',
  default: 'warehouses.cannotDeleteDefault',
  invalid_code: 'warehouses.codeRule',
};
const errorText = (err: unknown) => {
  const code = err instanceof ClientApiError ? Object.values(err.details ?? {})[0]?.[0] : undefined;
  return code && ERRORS[code] ? t(ERRORS[code]) : (err as Error).message;
};

/**
 * 仓库管理弹窗（需 product.manage；无权限时只读）。
 * Warehouse management dialog (product.manage; read-only otherwise).
 */
export function WarehousesModal({ open, onClose, canManage, onChanged }: { open: boolean; onClose: () => void; canManage: boolean; onChanged: () => void }) {
  const { message } = App.useApp();
  const { items, reload } = useWarehouses();
  const [editing, setEditing] = useState<Warehouse | 'new' | null>(null);
  const [form] = Form.useForm<{ code: string; name: string; address?: string | null; isActive: boolean; isDefault: boolean }>();
  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  const done = () => {
    reload();
    onChanged();
  };
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      done();
      return true;
    } catch (err) {
      message.error(errorText(err));
      return false;
    }
  };
  const save = async () => {
    const v = await form.validateFields();
    const body = { ...v, address: v.address || null };
    const ok = await run(() => (editing === 'new' ? api('/api/warehouses', { method: 'POST', body }) : api(`/api/warehouses/${(editing as Warehouse).id}`, { method: 'PATCH', body })));
    if (ok) {
      message.success(t('common.saved'));
      setEditing(null);
    }
  };
  const openForm = (w: Warehouse | 'new') => {
    form.resetFields();
    form.setFieldsValue(w === 'new' ? { code: '', name: '', address: null, isActive: true, isDefault: false } : { code: w.code, name: w.name, address: w.address, isActive: w.isActive, isDefault: w.isDefault });
    setEditing(w);
  };

  return (
    <Modal title={t('warehouses.title')} open={open} onCancel={onClose} footer={null} width={860} destroyOnHidden>
      <Typography.Paragraph type="secondary">{t('warehouses.hint')}</Typography.Paragraph>
      {canManage && (
        <Button type="primary" icon={<PlusOutlined />} style={{ marginBottom: 12 }} onClick={() => openForm('new')} data-testid="warehouse-new">
          {t('warehouses.new')}
        </Button>
      )}
      <Table<Warehouse>
        rowKey="id"
        size="small"
        dataSource={items}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: t('warehouses.code'), dataIndex: 'code' },
          {
            title: t('warehouses.name'),
            render: (_, w) => (
              <Space size={4}>
                {w.name}
                {w.isDefault && <Tag color="blue">{t('warehouses.default')}</Tag>}
                {!w.isActive && <Tag>{t('warehouses.inactiveTag')}</Tag>}
              </Space>
            ),
          },
          { title: t('warehouses.products'), dataIndex: 'products', align: 'right' },
          { title: t('warehouses.units'), align: 'right', render: (_, w) => String(Number(w.units)) },
          ...(canManage
            ? [
                {
                  title: t('common.actions'),
                  render: (_: unknown, w: Warehouse) => (
                    <Space size={4}>
                      <Button type="link" size="small" onClick={() => openForm(w)}>
                        {t('common.edit')}
                      </Button>
                      {!w.isDefault && w.isActive && (
                        <Button type="link" size="small" onClick={() => void run(() => api(`/api/warehouses/${w.id}`, { method: 'PATCH', body: { isDefault: true } }))}>
                          {t('warehouses.setDefault')}
                        </Button>
                      )}
                      {!w.isDefault && (
                        <Popconfirm title={t('warehouses.confirmDelete', { name: w.name })} onConfirm={() => void run(() => api(`/api/warehouses/${w.id}`, { method: 'DELETE' }))}>
                          <Button type="link" size="small" danger>
                            {t('common.delete')}
                          </Button>
                        </Popconfirm>
                      )}
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />
      <Modal title={editing === 'new' ? t('warehouses.new') : t('warehouses.edit')} open={editing !== null} onOk={save} onCancel={() => setEditing(null)} okText={t('common.save')} cancelText={t('common.cancel')} destroyOnHidden forceRender>
        <Form form={form} layout="vertical" name="warehouse">
          <Form.Item name="code" label={t('warehouses.code')} extra={t('warehouses.codeRule')} rules={[{ required: true, pattern: /^[A-Za-z0-9_-]{1,20}$/, message: t('warehouses.codeRule') }]}>
            <Input maxLength={20} style={{ textTransform: 'uppercase' }} />
          </Form.Item>
          <Form.Item name="name" label={t('warehouses.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('warehouses.name') }) }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="address" label={t('warehouses.address')}>
            <Input maxLength={500} />
          </Form.Item>
          <Space>
            <Form.Item name="isActive" label={t('warehouses.active')} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="isDefault" label={t('warehouses.default')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </Modal>
  );
}
