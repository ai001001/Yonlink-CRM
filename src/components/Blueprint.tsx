/**
 * 流程蓝图的共用界面：对象当前启用的蓝图（表单锁定受控字段）、记录详情中的流程面板（当前状态与可执行的转换，
 * 执行时按要求填写字段与备注）。
 * Shared blueprint UI: the active blueprint of a module (forms lock the controlled field) and the process panel in
 * record details (current state and runnable transitions, with the required fields and note).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Space, Tag, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';

/** 适用对象 / module */
export type BlueprintEntity = 'LEAD' | 'DEAL';
/** 状态的枚举前缀 / enum prefix of states */
const STATE_PREFIX: Record<BlueprintEntity, string> = { LEAD: 'leadStatus', DEAL: 'dealStage' };
/** 字段标签 / field labels */
export const BLUEPRINT_FIELD_LABELS: Record<string, MessageKey> = {
  company: 'leads.company',
  title: 'leads.jobTitle',
  phone: 'leads.phone',
  email: 'leads.email',
  description: 'common.description',
  amount: 'deals.amount',
  expectedCloseDate: 'deals.expectedCloseDate',
};
/** 状态显示 / state label */
export const stateLabel = (entity: BlueprintEntity, state: string) => tEnum(STATE_PREFIX[entity], state);

interface Available {
  blueprint: { id: string; name: string } | null;
  state: string;
  transitions: { id: string; name: string; to: string; fields: string[]; noteRequired: boolean }[];
}

/**
 * 对象当前启用的蓝图（没有时为 null）。
 * The active blueprint of a module (null when none).
 */
export function useBlueprintStatus(entity: BlueprintEntity) {
  const [active, setActive] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    api<{ active: { id: string; name: string } | null }>(`/api/blueprints/status?entity=${entity}`)
      .then((r) => setActive(r.active))
      .catch(() => setActive(null));
  }, [entity]);
  return active;
}

/**
 * 记录详情中的流程面板（没有启用的蓝图时不显示）。
 * Process panel in a record detail (hidden without an active blueprint).
 * @param record 记录当前值（预填转换字段）/ the record's current values (prefill transition fields)
 */
export function BlueprintPanel({ entity, record, onDone }: { entity: BlueprintEntity; record: { id: string } & Record<string, unknown>; onDone: () => void }) {
  const { message } = App.useApp();
  const [data, setData] = useState<Available | null>(null);
  const [running, setRunning] = useState<Available['transitions'][number] | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<Record<string, unknown>>();
  const id = record.id;
  const state = String(record[entity === 'LEAD' ? 'status' : 'stage'] ?? '');

  const load = useCallback(() => {
    api<Available>(`/api/blueprints/transitions?entity=${entity}&id=${id}`)
      .then(setData)
      .catch(() => setData(null));
  }, [entity, id]);
  // 记录状态变化后重新读取 / reload when the record's state changes
  useEffect(load, [load, state]);

  if (!data?.blueprint) return null;

  const open = (tr: Available['transitions'][number]) => {
    form.resetFields();
    form.setFieldsValue(
      Object.fromEntries(
        tr.fields.map((f) => {
          const v = record[f];
          return [f, f === 'expectedCloseDate' ? (v ? dayjs(String(v).slice(0, 10)) : null) : f === 'amount' && v !== null && v !== undefined ? String(v) : (v ?? null)];
        }),
      ),
    );
    setRunning(tr);
  };

  const submit = async () => {
    if (!running) return;
    const v = await form.validateFields();
    const fields = Object.fromEntries(
      running.fields.map((f) => {
        const x = v[f];
        return [f, f === 'expectedCloseDate' ? (x ? (x as Dayjs).format('YYYY-MM-DD') : null) : x === '' ? null : x];
      }),
    );
    setSaving(true);
    try {
      await api('/api/blueprints/transitions', { method: 'POST', body: { entity, id, transitionId: running.id, fields, note: (v.note as string | undefined) || undefined } });
      message.success(t('blueprints.done', { state: stateLabel(entity, running.to) }));
      setRunning(null);
      onDone();
    } catch (err) {
      if (err instanceof ClientApiError && err.details) {
        const errors = Object.entries(err.details).map(([k, codes]) => ({ name: k.replace(/^fields\./, ''), errors: [codes[0] === 'required' ? t('common.required', { field: t(BLUEPRINT_FIELD_LABELS[k.replace(/^fields\./, '')] ?? 'common.description') }) : codes[0] === 'state_changed' ? t('blueprints.stateChanged') : String(codes[0])] }));
        form.setFields(errors.filter((e) => e.name === 'note' || running.fields.includes(e.name)));
      }
      message.error(err instanceof ClientApiError && err.details?.stage?.[0] === 'state_changed' ? t('blueprints.stateChanged') : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card size="small" style={{ marginBottom: 16 }} data-testid="blueprint-panel" title={t('blueprints.panelTitle', { name: data.blueprint.name })} extra={<Tag color="processing">{t('blueprints.current', { state: stateLabel(entity, data.state) })}</Tag>}>
      {data.transitions.length ? (
        <Space wrap>
          {data.transitions.map((tr) => (
            <Button key={tr.id} type="primary" ghost onClick={() => open(tr)}>
              {tr.name} → {stateLabel(entity, tr.to)}
            </Button>
          ))}
        </Space>
      ) : (
        <Typography.Text type="secondary">{t('blueprints.noTransition')}</Typography.Text>
      )}
      <Modal title={running ? t('blueprints.run', { name: running.name }) : ''} open={running !== null} onOk={submit} confirmLoading={saving} onCancel={() => setRunning(null)} okText={t('common.save')} cancelText={t('common.cancel')} destroyOnHidden forceRender>
        <Form form={form} layout="vertical" name="blueprint-transition">
          {running?.fields.map((f) => {
            const rules = [{ required: true, message: t('common.required', { field: t(BLUEPRINT_FIELD_LABELS[f] ?? 'common.description') }) }];
            return (
              <Form.Item key={f} name={f} label={t(BLUEPRINT_FIELD_LABELS[f] ?? 'common.description')} rules={rules}>
                {f === 'amount' ? (
                  <InputNumber<string> stringMode min="0.01" precision={2} style={{ width: '100%' }} />
                ) : f === 'expectedCloseDate' ? (
                  <DatePicker style={{ width: '100%' }} />
                ) : f === 'description' ? (
                  <Input.TextArea rows={3} maxLength={5000} />
                ) : (
                  <Input maxLength={f === 'email' ? 254 : 200} />
                )}
              </Form.Item>
            );
          })}
          <Form.Item name="note" label={t('blueprints.note')} rules={running?.noteRequired ? [{ required: true, whitespace: true, message: t('common.required', { field: t('blueprints.note') }) }] : []}>
            <Input.TextArea rows={3} maxLength={5000} placeholder={t('blueprints.notePlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
