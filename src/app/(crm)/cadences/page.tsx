/**
 * 销售节奏页（设置 › 销售节奏，需 cadence.manage）：节奏列表（对象、步骤、退出状态、参与数、启用）与新建/编辑弹窗。
 * Cadences page (Setup › Cadences, cadence.manage): the cadence list (module, steps, exit states, enrollment counts,
 * active) and the create/edit dialog.
 */
'use client';

import { useState } from 'react';
import { App, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { CADENCE_STATE_PREFIX, stepText, useCadences, type Cadence, type CadenceEntity, type CadenceStep } from '@/components/Cadences';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';

/** 各对象可作为退出条件的状态（与服务端一致）/ exit states per module (same as the server) */
const EXIT_STATES: Record<CadenceEntity, string[]> = {
  LEAD: ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED'],
  DEAL: ['QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'],
};
const STEP_TYPES = ['CALL', 'MEETING', 'VISIT', 'TASK'] as const;

interface FormValues {
  name: string;
  description?: string | null;
  entity: CadenceEntity;
  isActive: boolean;
  steps: CadenceStep[];
  exitStates: string[];
}

/** 服务端错误代码 → 提示 / server error codes → messages */
const ERRORS: Record<string, MessageKey> = { taken: 'cadences.taken', limit_reached: 'cadences.limit', not_ordered: 'cadences.notOrdered' };

export default function CadencesPage() {
  const { message } = App.useApp();
  const [entity, setEntity] = useState<'ALL' | CadenceEntity>('ALL');
  const { items, reload } = useCadences(entity === 'ALL' ? undefined : entity);
  const [editing, setEditing] = useState<Cadence | 'new' | null>(null);
  const [form] = Form.useForm<FormValues>();
  const formEntity = (Form.useWatch('entity', form) ?? 'LEAD') as CadenceEntity;

  const open = (c: Cadence | 'new') => {
    form.resetFields();
    form.setFieldsValue(
      c === 'new'
        ? { name: '', description: null, entity: 'LEAD', isActive: true, steps: [{ day: 0, type: 'CALL', subject: '' }], exitStates: [] }
        : { name: c.name, description: c.description, entity: c.entity, isActive: c.isActive, steps: c.steps, exitStates: c.exitStates },
    );
    setEditing(c);
  };

  const showError = (err: unknown) => {
    const details = err instanceof ClientApiError ? err.details : undefined;
    const name = details?.name?.[0];
    if (name && ERRORS[name]) {
      form.setFields([{ name: 'name', errors: [t(ERRORS[name]!)] }]);
      return;
    }
    if (details && Object.entries(details).some(([k, v]) => k.startsWith('steps') && v[0] === 'not_ordered')) {
      message.error(t('cadences.notOrdered'));
      return;
    }
    message.error((err as Error).message);
  };

  const save = async () => {
    const v = await form.validateFields();
    const body = { ...v, description: v.description || null, exitStates: v.exitStates ?? [] };
    try {
      if (editing === 'new') await api('/api/cadences', { method: 'POST', body });
      else await api(`/api/cadences/${(editing as Cadence).id}`, { method: 'PATCH', body });
      message.success(t('common.saved'));
      setEditing(null);
      reload();
    } catch (err) {
      showError(err);
    }
  };

  const toggle = async (c: Cadence, isActive: boolean) => {
    try {
      await api(`/api/cadences/${c.id}`, { method: 'PATCH', body: { isActive } });
      reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const remove = async (c: Cadence) => {
    try {
      await api(`/api/cadences/${c.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const required = (key: MessageKey) => [{ required: true, message: t('common.required', { field: t(key) }) }];

  return (
    <Card
      title={t('cadences.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')} data-testid="cadence-new">
          {t('cadences.new')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">{t('cadences.hint')}</Typography.Paragraph>
      <Segmented
        style={{ marginBottom: 16 }}
        value={entity}
        onChange={(v) => setEntity(v as 'ALL' | CadenceEntity)}
        options={[
          { value: 'ALL', label: t('workflows.all') },
          { value: 'LEAD', label: t('workflows.entity.LEAD') },
          { value: 'DEAL', label: t('workflows.entity.DEAL') },
        ]}
      />
      <Table<Cadence>
        rowKey="id"
        dataSource={items}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('cadences.empty') }}
        columns={[
          {
            title: t('cadences.name'),
            render: (_, c) => (
              <>
                {c.name}
                {c.description && (
                  <div>
                    <Typography.Text type="secondary">{c.description}</Typography.Text>
                  </div>
                )}
              </>
            ),
          },
          { title: t('cadences.entity'), render: (_, c) => <Tag>{t(`workflows.entity.${c.entity}`)}</Tag> },
          { title: t('cadences.steps'), render: (_, c) => c.steps.map((s, i) => <div key={i}>{stepText(s)}</div>) },
          { title: t('cadences.exitStates'), render: (_, c) => (c.exitStates.length ? c.exitStates.map((s) => tEnum(CADENCE_STATE_PREFIX[c.entity], s)).join(t('common.listSep')) : '—') },
          { title: t('cadences.panelTitle'), render: (_, c) => t('cadences.counts', c.counts) },
          { title: t('cadences.active'), render: (_, c) => <Switch size="small" checked={c.isActive} aria-label={`${t('cadences.active')} ${c.name}`} onChange={(v) => void toggle(c, v)} /> },
          {
            title: t('common.actions'),
            render: (_, c) => (
              <Space>
                <Button type="link" size="small" onClick={() => open(c)}>
                  {t('common.edit')}
                </Button>
                <Popconfirm title={t('cadences.confirmDelete', { name: c.name })} onConfirm={() => void remove(c)}>
                  <Button type="link" size="small" danger>
                    {t('common.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal title={editing === 'new' ? t('cadences.new') : t('cadences.edit')} open={editing !== null} onOk={save} onCancel={() => setEditing(null)} okText={t('common.save')} cancelText={t('common.cancel')} width={860} forceRender destroyOnHidden>
        <Form form={form} name="cadence" layout="vertical">
          <Space align="start" wrap>
            <Form.Item name="name" label={t('cadences.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('cadences.name') }) }]}>
              <Input maxLength={100} style={{ width: 240 }} />
            </Form.Item>
            <Form.Item name="entity" label={t('cadences.entity')}>
              <Select style={{ width: 120 }} disabled={editing !== 'new'} options={(['LEAD', 'DEAL'] as const).map((e) => ({ value: e, label: t(`workflows.entity.${e}`) }))} onChange={() => form.setFieldValue('exitStates', [])} />
            </Form.Item>
            <Form.Item name="isActive" label={t('cadences.active')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="description" label={t('cadences.description')}>
            <Input maxLength={500} />
          </Form.Item>
          <Form.Item name="exitStates" label={t('cadences.exitStates')}>
            <Select mode="multiple" allowClear options={EXIT_STATES[formEntity].map((s) => ({ value: s, label: tEnum(CADENCE_STATE_PREFIX[formEntity], s) }))} />
          </Form.Item>
          <Typography.Title level={5}>{t('cadences.steps')}</Typography.Title>
          <Form.List name="steps">
            {(rows, { add, remove: drop }) => (
              <div data-testid="cadence-steps">
                {rows.map((row, i) => {
                  const label = `${i + 1}`;
                  return (
                    <Space key={row.key} align="start" wrap style={{ display: 'flex' }}>
                      <Form.Item name={[row.name, 'day']} rules={required('cadences.day')}>
                        <InputNumber aria-label={`${t('cadences.day')} ${label}`} min={0} max={365} precision={0} prefix={t('cadences.day')} style={{ width: 140 }} />
                      </Form.Item>
                      <Form.Item name={[row.name, 'type']} style={{ width: 120 }}>
                        <Select aria-label={`${t('cadences.stepType')} ${label}`} options={STEP_TYPES.map((x) => ({ value: x, label: tEnum('activityType', x) }))} />
                      </Form.Item>
                      <Form.Item name={[row.name, 'subject']} style={{ width: 340 }} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('cadences.subject') }) }]}>
                        <Input aria-label={`${t('cadences.subject')} ${label}`} placeholder={t('cadences.subject')} maxLength={200} />
                      </Form.Item>
                      <Button icon={<DeleteOutlined />} disabled={rows.length === 1} aria-label={`${t('cadences.removeStep')} ${label}`} onClick={() => drop(row.name)} />
                    </Space>
                  );
                })}
                {rows.length < 10 && (
                  <Button
                    size="small"
                    type="dashed"
                    icon={<PlusOutlined />}
                    data-testid="cadence-add-step"
                    onClick={() => {
                      const steps = (form.getFieldValue('steps') ?? []) as CadenceStep[];
                      add({ day: (steps[steps.length - 1]?.day ?? 0) + 3, type: 'TASK', subject: '' });
                    }}
                  >
                    {t('cadences.addStep')}
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
