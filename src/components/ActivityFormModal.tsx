/**
 * 跟进记录新增/编辑弹窗。
 * Create / edit activity modal.
 */
'use client';

import { useEffect, useState } from 'react';
import { App, DatePicker, Form, Input, Modal, Select, Switch } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { t } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { pickOptions, pickValues } from '@/lib/picklists';
import { toFormErrors, useOwners } from '@/lib/hooks';
import type { Activity, ActivityRelation } from '@/lib/types';
import { usePermissions } from './AuthProvider';

export const ACTIVITY_TYPES = ['CALL', 'MEETING', 'VISIT', 'TASK'] as const;
/**
 * 跟进类型选项（按组织配置；筛选含已停用的，表单只含启用的并保留当前值）。
 * Activity type options (organization setup; filters include inactive ones, forms list active ones and keep the current value).
 */
export const activityTypeOptions = (mode: 'all' | 'active' = 'all', keep?: string | null) => pickOptions('activityType', ACTIVITY_TYPES, mode, keep);

interface Props {
  /** 是否打开 / open state */
  open: boolean;
  /** 编辑的记录；为空时新建 / record to edit; create when null */
  editing?: Activity | null;
  /** 固定关联（从客户/线索/商机详情中新建）/ pinned relation */
  relation?: ActivityRelation;
  /** 额外表单项（如关联对象选择）/ extra form items (e.g. relation pickers) */
  extra?: React.ReactNode;
  /** 新建时的默认截止时间（如从日历某天新建）/ default due time when creating (e.g. from a calendar day) */
  defaultDueAt?: Dayjs | null;
  onClose: () => void;
  onSaved: (activity: Activity) => void;
}

interface FormValues {
  type: Activity['type'];
  subject: string;
  content?: string;
  dueAt?: Dayjs | null;
  completed?: boolean;
  ownerId?: string | null;
  accountId?: string | null;
  leadId?: string | null;
  dealId?: string | null;
}

export function ActivityFormModal({ open, editing, relation, extra, defaultDueAt, onClose, onSaved }: Props) {
  const { message } = App.useApp();
  const owners = useOwners();
  const perm = usePermissions();
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (editing) form.setFieldsValue({ ...editing, content: editing.content ?? undefined, dueAt: editing.dueAt ? dayjs(editing.dueAt) : null });
    else if (defaultDueAt) form.setFieldsValue({ dueAt: defaultDueAt });
  }, [open, editing, defaultDueAt, form]);

  const save = async () => {
    const v = await form.validateFields();
    const body = { ...v, ...relation, dueAt: v.dueAt ? v.dueAt.toISOString() : null };
    setSaving(true);
    try {
      const saved = editing
        ? await api<Activity>(`/api/activities/${editing.id}`, { method: 'PATCH', body })
        : await api<Activity>('/api/activities', { method: 'POST', body });
      message.success(t('common.saved'));
      onSaved(saved);
    } catch (err) {
      if (err instanceof ClientApiError) form.setFields(toFormErrors(err.details) as never);
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={editing ? t('activities.edit') : t('activities.new')}
      open={open}
      onOk={save}
      onCancel={onClose}
      confirmLoading={saving}
      okText={t('common.save')}
      width={600}
      forceRender
      zIndex={1100}
    >
      <Form form={form} name="activity" layout="vertical" initialValues={{ type: pickValues('activityType', ACTIVITY_TYPES, 'active')[0] ?? 'CALL', completed: false }}>
        <div className="form-row">
          <Form.Item name="type" label={t('activities.type')} rules={[{ required: true }]}>
            <Select options={activityTypeOptions('active', editing?.type)} />
          </Form.Item>
          <Form.Item name="dueAt" label={t('activities.dueAt')}>
            <DatePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
          </Form.Item>
        </div>
        <Form.Item
          name="subject"
          label={t('activities.subject')}
          rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('activities.subject') }) }]}
        >
          <Input maxLength={200} />
        </Form.Item>
        <Form.Item name="content" label={t('activities.content')}>
          <Input.TextArea rows={4} maxLength={10000} />
        </Form.Item>
        {extra}
        <div className="form-row">
          <Form.Item name="ownerId" label={t('common.owner')} extra={perm.canAssign ? undefined : t('common.ownerLocked')}>
            <Select allowClear={perm.canAssign} disabled={!perm.canAssign} options={owners.map((u) => ({ value: u.id, label: u.name }))} />
          </Form.Item>
          <Form.Item name="completed" label={t('activities.completed')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}
