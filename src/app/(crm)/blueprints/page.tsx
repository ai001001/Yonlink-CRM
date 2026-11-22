/**
 * 流程蓝图页（设置 › 流程蓝图，需 blueprint.manage）：蓝图列表（对象、控制字段、转换、启用）与新建/编辑弹窗。
 * Blueprints page (Setup › Blueprints, blueprint.manage): the blueprint list (module, controlled field, transitions,
 * active) and the create/edit dialog.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { BLUEPRINT_FIELD_LABELS, stateLabel, type BlueprintEntity } from '@/components/Blueprint';
import { t, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';

/** 各对象的状态与可要求的字段（与服务端一致）/ states and requirable fields per module (same as the server) */
const STATES: Record<BlueprintEntity, string[]> = {
  LEAD: ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED'],
  DEAL: ['QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'],
};
const FIELDS: Record<BlueprintEntity, string[]> = { LEAD: ['company', 'title', 'phone', 'email', 'description'], DEAL: ['amount', 'expectedCloseDate', 'description'] };
const ROLES = ['ADMIN', 'MANAGER', 'SALES'] as const;
/** 控制的字段名称 / controlled field label */
const CONTROLS: Record<BlueprintEntity, MessageKey> = { LEAD: 'leads.status', DEAL: 'deals.stage' };

interface Transition {
  id?: string;
  name: string;
  from: string[];
  to: string;
  roles: string[];
  fields: string[];
  noteRequired: boolean;
}
interface Blueprint {
  id: string;
  name: string;
  description: string | null;
  entity: BlueprintEntity;
  isActive: boolean;
  transitions: Transition[];
  createdBy: { id: string; name: string };
}
type FormValues = Omit<Blueprint, 'id' | 'createdBy'>;

/** 服务端错误代码 → 提示 / server error codes → messages */
const ERRORS: Record<string, MessageKey> = { taken: 'blueprints.taken', limit_reached: 'blueprints.limit', another_active: 'blueprints.anotherActive' };

/** 默认的新转换 / a new transition */
const newTransition = (entity: BlueprintEntity, i: number): Transition => ({ name: '', from: [STATES[entity][i % STATES[entity].length]!], to: STATES[entity][(i + 1) % STATES[entity].length]!, roles: [...ROLES], fields: [], noteRequired: false });

export default function BlueprintsPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Blueprint[]>([]);
  const [editing, setEditing] = useState<Blueprint | 'new' | null>(null);
  const [form] = Form.useForm<FormValues>();
  const formEntity = (Form.useWatch('entity', form) ?? 'DEAL') as BlueprintEntity;

  const load = useCallback(() => {
    api<{ items: Blueprint[] }>('/api/blueprints')
      .then((r) => setRows(r.items))
      .catch((err: Error) => message.error(err.message));
  }, [message]);
  useEffect(load, [load]);

  const open = (b: Blueprint | 'new') => {
    form.resetFields();
    form.setFieldsValue(
      b === 'new'
        ? { name: '', description: null, entity: 'DEAL', isActive: false, transitions: [newTransition('DEAL', 0)] }
        : { name: b.name, description: b.description, entity: b.entity, isActive: b.isActive, transitions: b.transitions },
    );
    setEditing(b);
  };

  const showError = (err: unknown) => {
    const details = err instanceof ClientApiError ? err.details : undefined;
    const entry = Object.entries(details ?? {}).find(([, codes]) => ERRORS[codes[0] ?? '']);
    if (entry) {
      const field = entry[0] === 'isActive' ? 'isActive' : 'name';
      form.setFields([{ name: field, errors: [t(ERRORS[entry[1][0]!]!)] }]);
      return;
    }
    if (details && Object.keys(details).some((k) => k.startsWith('transitions'))) {
      message.error(t('blueprints.invalid'));
      return;
    }
    message.error((err as Error).message);
  };

  const save = async () => {
    const v = await form.validateFields();
    const body = { ...v, description: v.description || null, transitions: v.transitions.map((tr) => ({ ...tr, fields: tr.fields ?? [], noteRequired: !!tr.noteRequired })) };
    try {
      if (editing === 'new') await api('/api/blueprints', { method: 'POST', body });
      else await api(`/api/blueprints/${(editing as Blueprint).id}`, { method: 'PATCH', body });
      message.success(t('common.saved'));
      setEditing(null);
      load();
    } catch (err) {
      showError(err);
    }
  };

  const toggle = async (b: Blueprint, isActive: boolean) => {
    try {
      await api(`/api/blueprints/${b.id}`, { method: 'PATCH', body: { isActive } });
      load();
    } catch (err) {
      const code = err instanceof ClientApiError ? err.details?.isActive?.[0] : undefined;
      message.error(code && ERRORS[code] ? t(ERRORS[code]!) : (err as Error).message);
    }
  };

  const remove = async (b: Blueprint) => {
    try {
      await api(`/api/blueprints/${b.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const transitionText = (e: BlueprintEntity, tr: Transition) => t('blueprints.transitionText', { name: tr.name, from: tr.from.map((s) => stateLabel(e, s)).join(' / '), to: stateLabel(e, tr.to) });
  const stateOptions = STATES[formEntity].map((s) => ({ value: s, label: stateLabel(formEntity, s) }));
  const required = (key: MessageKey) => [{ required: true, message: t('common.required', { field: t(key) }) }];

  return (
    <Card
      title={t('blueprints.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')} data-testid="blueprint-new">
          {t('blueprints.new')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">{t('blueprints.hint')}</Typography.Paragraph>
      <Table<Blueprint>
        rowKey="id"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('blueprints.empty') }}
        columns={[
          {
            title: t('blueprints.name'),
            render: (_, b) => (
              <>
                {b.name}
                {b.description && (
                  <div>
                    <Typography.Text type="secondary">{b.description}</Typography.Text>
                  </div>
                )}
              </>
            ),
          },
          { title: t('blueprints.entity'), render: (_, b) => <Tag>{t(`workflows.entity.${b.entity}`)}</Tag> },
          { title: t('blueprints.controls'), render: (_, b) => t(CONTROLS[b.entity]) },
          { title: t('blueprints.transitions'), render: (_, b) => b.transitions.map((tr) => <div key={tr.id}>{transitionText(b.entity, tr)}</div>) },
          { title: t('blueprints.active'), render: (_, b) => <Switch size="small" checked={b.isActive} aria-label={`${t('blueprints.active')} ${b.name}`} onChange={(v) => void toggle(b, v)} /> },
          {
            title: t('common.actions'),
            render: (_, b) => (
              <Space>
                <Button type="link" size="small" onClick={() => open(b)}>
                  {t('common.edit')}
                </Button>
                <Popconfirm title={t('blueprints.confirmDelete', { name: b.name })} onConfirm={() => void remove(b)}>
                  <Button type="link" size="small" danger>
                    {t('common.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal title={editing === 'new' ? t('blueprints.new') : t('blueprints.edit')} open={editing !== null} onOk={save} onCancel={() => setEditing(null)} okText={t('common.save')} cancelText={t('common.cancel')} width={1000} forceRender destroyOnHidden>
        <Form form={form} name="blueprint" layout="vertical">
          <Space align="start" wrap>
            <Form.Item name="name" label={t('blueprints.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('blueprints.name') }) }]}>
              <Input maxLength={100} style={{ width: 240 }} />
            </Form.Item>
            <Form.Item name="entity" label={t('blueprints.entity')} extra={t('blueprints.controls') + t('common.colon') + t(CONTROLS[formEntity])}>
              <Select
                style={{ width: 140 }}
                disabled={editing !== 'new'}
                options={(['LEAD', 'DEAL'] as const).map((e) => ({ value: e, label: t(`workflows.entity.${e}`) }))}
                onChange={(e: BlueprintEntity) => form.setFieldValue('transitions', [newTransition(e, 0)])}
              />
            </Form.Item>
            <Form.Item name="isActive" label={t('blueprints.active')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="description" label={t('blueprints.description')}>
            <Input maxLength={500} />
          </Form.Item>
          <Typography.Title level={5}>{t('blueprints.transitions')}</Typography.Title>
          <Form.List name="transitions">
            {(list, { add, remove: drop }) => (
              <div data-testid="blueprint-transitions">
                {list.map((row, i) => {
                  const label = `${i + 1}`;
                  return (
                    <Space key={row.key} align="start" wrap style={{ display: 'flex', borderBottom: '1px dashed #eee', marginBottom: 8 }}>
                      <Form.Item name={[row.name, 'name']} style={{ width: 150 }} rules={required('blueprints.transitionName')}>
                        <Input aria-label={`${t('blueprints.transitionName')} ${label}`} placeholder={t('blueprints.transitionName')} maxLength={50} />
                      </Form.Item>
                      <Form.Item name={[row.name, 'from']} style={{ width: 230 }} rules={required('blueprints.from')}>
                        <Select mode="multiple" aria-label={`${t('blueprints.from')} ${label}`} placeholder={t('blueprints.from')} options={stateOptions} />
                      </Form.Item>
                      <Form.Item name={[row.name, 'to']} style={{ width: 130 }} rules={required('blueprints.to')}>
                        <Select aria-label={`${t('blueprints.to')} ${label}`} placeholder={t('blueprints.to')} options={stateOptions} />
                      </Form.Item>
                      <Form.Item name={[row.name, 'roles']} style={{ width: 240 }} rules={required('blueprints.roles')}>
                        <Select mode="multiple" aria-label={`${t('blueprints.roles')} ${label}`} placeholder={t('blueprints.roles')} options={ROLES.map((r) => ({ value: r, label: t(`role.${r}`) }))} />
                      </Form.Item>
                      <Form.Item name={[row.name, 'fields']} style={{ width: 200 }}>
                        <Select mode="multiple" aria-label={`${t('blueprints.fields')} ${label}`} placeholder={t('blueprints.fields')} options={FIELDS[formEntity].map((f) => ({ value: f, label: t(BLUEPRINT_FIELD_LABELS[f]!) }))} />
                      </Form.Item>
                      <Form.Item name={[row.name, 'noteRequired']} valuePropName="checked">
                        <Switch aria-label={`${t('blueprints.noteRequired')} ${label}`} checkedChildren={t('blueprints.noteRequired')} unCheckedChildren={t('blueprints.noteRequired')} />
                      </Form.Item>
                      <Button icon={<DeleteOutlined />} disabled={list.length === 1} aria-label={`${t('blueprints.removeTransition')} ${label}`} onClick={() => drop(row.name)} />
                    </Space>
                  );
                })}
                {list.length < 20 && (
                  <Button size="small" type="dashed" icon={<PlusOutlined />} data-testid="blueprint-add-transition" onClick={() => add(newTransition(formEntity, list.length))}>
                    {t('blueprints.addTransition')}
                  </Button>
                )}
              </div>
            )}
          </Form.List>
        </Form>
      </Modal>
    </Card>
  );
}
