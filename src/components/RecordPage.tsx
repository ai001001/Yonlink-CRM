/**
 * 记录整页详情（对标 Zoho 的记录详情页）：顶部摘要、左侧字段（有编辑权限时点字段直接修改）、右侧页签
 * （时间线与各相关列表）。线索、客户、商机共用；各页面传入字段与页签配置。
 * Full-page record detail (cf. the Zoho record page): a summary header, fields on the left (click to edit in place
 * with edit rights) and tabs on the right (timeline and related lists). Shared by leads, accounts and deals, each
 * page passing its fields and tabs.
 */
'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Alert, App, Button, Card, Col, DatePicker, Empty, Input, InputNumber, Result, Row, Select, Space, Tabs, Tag, Timeline, Typography } from 'antd';
import { CheckOutlined, CloseOutlined, EditOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { AuditChanges, actionLabel, type AuditLogEntry } from '@/components/AuditChanges';
import { usePermissions } from '@/components/AuthProvider';
import { useCustomFields, type CustomEntity, type CustomFieldDef } from '@/components/CustomFields';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, qs } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useOwners } from '@/lib/hooks';

/** 字段编辑器类型 / editor kinds */
export type EditorKind = 'text' | 'textarea' | 'select' | 'owner' | 'date' | 'amount' | 'none';

/** 字段配置 / field configuration */
export interface FieldConfig<R> {
  key: string;
  label: MessageKey;
  /** 显示值 / display */
  render: (r: R) => ReactNode;
  /** 编辑器（none 为只读）/ editor (none is read-only) */
  editor: EditorKind;
  /** 编辑时的当前值 / the value being edited */
  value?: (r: R) => string | null;
  /** 下拉选项（按记录，如保留当前已停用的值）/ select options (per record, e.g. keeping an inactive current value) */
  options?: (r: R) => { value: string; label: string }[];
  /** 必填 / required */
  required?: boolean;
  /** 此记录是否可改此字段（默认可改）/ whether this field may change on this record (default yes) */
  editable?: (r: R) => boolean;
  /** 占整行 / full width */
  wide?: boolean;
}

/** 页签 / tab */
export interface TabConfig {
  key: string;
  label: string;
  children: ReactNode;
}

/** 基本记录形状 / the minimal record shape */
export interface BaseRecord {
  id: string;
  name: string;
  ownerId: string | null;
  updatedAt: string;
  custom?: Record<string, unknown> | null;
}

/**
 * 单个字段：显示值；可编辑时点击（或按钮）进入编辑，保存时只提交该字段。
 * One field: shows the value; with edit rights a click (or the button) edits it and saving sends that field only.
 */
function InlineField({ label, display, editor, initial, options, required, canEdit, onSave }: {
  label: string;
  display: ReactNode;
  editor: EditorKind;
  initial: string | null;
  options?: { value: string; label: string }[];
  required?: boolean;
  canEdit: boolean;
  onSave: (value: string | null) => Promise<boolean>;
}) {
  const owners = useOwners();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<string | null>(initial);
  const [saving, setSaving] = useState(false);
  const editable = canEdit && editor !== 'none';
  const start = () => {
    setValue(initial);
    setEditing(true);
  };
  const save = async () => {
    if (required && !value?.trim()) return;
    setSaving(true);
    if (await onSave(value === '' ? null : value)) setEditing(false);
    setSaving(false);
  };
  const aria = t('record.edit', { field: label });
  let input: ReactNode = null;
  if (editing) {
    const common = { 'aria-label': label, autoFocus: true, style: { width: '100%' } };
    if (editor === 'textarea') input = <Input.TextArea {...common} rows={3} value={value ?? ''} onChange={(e) => setValue(e.target.value)} />;
    else if (editor === 'select') input = <Select {...common} allowClear={!required} options={options} value={value ?? undefined} onChange={(v) => setValue(v ?? null)} />;
    else if (editor === 'owner') input = <Select {...common} allowClear options={owners.map((u) => ({ value: u.id, label: u.name }))} value={value ?? undefined} onChange={(v) => setValue(v ?? null)} />;
    else if (editor === 'date') input = <DatePicker {...common} value={value ? dayjs(value) : null} onChange={(d) => setValue(d ? d.format('YYYY-MM-DD') : null)} />;
    else if (editor === 'amount') input = <InputNumber<string> {...common} stringMode min="0" precision={2} value={value ?? undefined} onChange={(v) => setValue(v ?? null)} />;
    else input = <Input {...common} value={value ?? ''} onChange={(e) => setValue(e.target.value)} onPressEnter={() => void save()} />;
  }
  return (
    <div data-testid="record-field" style={{ padding: '8px 0', borderBottom: '1px solid #f0f2f5' }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
      {editing ? (
        <Space.Compact style={{ width: '100%', marginTop: 4 }}>
          {input}
          <Button type="primary" icon={<CheckOutlined />} loading={saving} disabled={required && !value?.trim()} onClick={() => void save()} aria-label={t('common.save')} />
          <Button icon={<CloseOutlined />} onClick={() => setEditing(false)} aria-label={t('common.cancel')} />
        </Space.Compact>
      ) : (
        <div
          style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 2, cursor: editable ? 'pointer' : undefined, whiteSpace: editor === 'textarea' ? 'pre-wrap' : undefined }}
          onClick={editable ? start : undefined}
        >
          <div style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{display ?? '—'}</div>
          {editable && <Button type="text" size="small" icon={<EditOutlined />} aria-label={aria} onClick={(e) => (e.stopPropagation(), start())} />}
        </div>
      )}
    </div>
  );
}

/** 自定义字段的编辑器类型 / editor kind of a custom field */
const customEditor = (d: CustomFieldDef): EditorKind => (d.type === 'TEXTAREA' ? 'textarea' : d.type === 'PICKLIST' || d.type === 'CHECKBOX' ? 'select' : d.type === 'DATE' ? 'date' : 'text');

/** 时间线条目 / timeline item */
type Item =
  | { kind: 'activity'; id: string; at: string; activity: { type: string; subject: string; dueAt: string | null; completed: boolean; owner: { name: string } | null } }
  | { kind: 'note'; id: string; at: string; note: { content: string; author: { name: string } | null } }
  | { kind: 'audit'; id: string; at: string; entry: AuditLogEntry };

/**
 * 时间线：跟进、备注与修改记录合并，最新在前，可加载更多。
 * Timeline: activities, notes and changes merged, newest first, with "load more".
 */
export function RecordTimeline({ entity, id, version }: { entity: 'lead' | 'account' | 'deal'; id: string; version: string }) {
  const { message } = App.useApp();
  const owners = useOwners();
  const users = new Map(owners.map((u) => [u.id, u.name]));
  const [items, setItems] = useState<Item[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const load = useCallback(
    async (after: Item[]) => {
      const last = after[after.length - 1];
      const exclude = last ? after.filter((x) => x.at === last.at).map((x) => x.id).join(',') : undefined;
      try {
        const r = await api<{ items: Item[]; hasMore: boolean }>(`/api/timeline${qs({ entity, id, before: last?.at, exclude })}`);
        setItems([...after, ...r.items]);
        setHasMore(r.hasMore);
      } catch (err) {
        message.error((err as Error).message);
      }
    },
    [entity, id, message],
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load([]);
  }, [load, version]);
  if (!items.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('record.noTimeline')} />;
  return (
    <div data-testid="record-timeline">
      <Timeline
        items={items.map((x) => ({
          key: `${x.kind}-${x.id}`,
          color: x.kind === 'activity' ? 'blue' : x.kind === 'note' ? 'green' : 'gray',
          content: (
            <div data-testid="timeline-item">
              <Space size={6} wrap>
                <Tag>{t(`record.kind.${x.kind}`)}</Tag>
                <Typography.Text type="secondary">{fmtDateTime(x.at)}</Typography.Text>
                <Typography.Text type="secondary">{x.kind === 'activity' ? x.activity.owner?.name : x.kind === 'note' ? x.note.author?.name : x.entry.actor?.name}</Typography.Text>
              </Space>
              {x.kind === 'activity' && (
                <div>
                  {tEnum('activityType', x.activity.type)} · {x.activity.subject}
                  {x.activity.dueAt && <Typography.Text type="secondary"> · {t('record.due', { time: fmtDateTime(x.activity.dueAt) })}</Typography.Text>}
                  {x.activity.completed && <Tag color="green" style={{ marginLeft: 8 }}>{t('record.done')}</Tag>}
                </div>
              )}
              {x.kind === 'note' && <div style={{ whiteSpace: 'pre-wrap' }}>{x.note.content}</div>}
              {x.kind === 'audit' && (
                <div>
                  <div>{actionLabel(x.entry.action)}</div>
                  <AuditChanges entry={x.entry} users={users} />
                </div>
              )}
            </div>
          ),
        }))}
      />
      {hasMore && <Button onClick={() => void load(items)}>{t('record.loadMore')}</Button>}
    </div>
  );
}

/**
 * 整页详情：读取记录，显示摘要、字段（可直接编辑）与页签。
 * The full page: loads the record and shows the summary, editable fields and tabs.
 */
export function RecordPage<R extends BaseRecord>({
  id,
  path,
  listPath,
  customEntity,
  title,
  summary,
  fields,
  tabs,
  extraEditable,
}: {
  id: string;
  /** 记录接口，如 /api/leads / record API */
  path: string;
  /** 列表页 / list page */
  listPath: string;
  customEntity: CustomEntity;
  title: MessageKey;
  /** 顶部摘要（标签等）/ summary tags in the header */
  summary: (r: R, reload: () => void) => ReactNode;
  fields: FieldConfig<R>[];
  /** 页签（时间线由本组件提供）/ tabs (the timeline is provided here) */
  tabs: (r: R, reload: () => void, version: string) => TabConfig[];
  /** 除负责人规则外的可编辑条件（如已转化的线索）/ extra edit condition (e.g. converted leads) */
  extraEditable?: (r: R) => boolean;
}) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const customDefs = useCustomFields(customEntity);
  const [record, setRecord] = useState<R | null | 'missing'>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => {
    api<R>(`${path}/${id}`)
      .then((r) => {
        setRecord(r);
        setVersion((v) => v + 1);
      })
      .catch(() => setRecord('missing'));
  }, [path, id]);
  useEffect(reload, [reload]);

  if (record === 'missing') return <Result status="404" title={t('record.notFound')} extra={<Link href={listPath}>{t('record.back')}</Link>} />;
  if (!record) return null;
  const canEdit = perm.canEdit(record) && (extraEditable ? extraEditable(record) : true);

  const save = async (body: Record<string, unknown>) => {
    try {
      await api(`${path}/${record.id}`, { method: 'PATCH', body });
      message.success(t('common.saved'));
      reload();
      return true;
    } catch (err) {
      message.error(t('record.saveError', { message: (err as Error).message }));
      return false;
    }
  };
  const tag = `${record.updatedAt}:${version}`;
  const timelineEntity = path.endsWith('leads') ? 'lead' : path.endsWith('accounts') ? 'account' : 'deal';
  return (
    <div data-testid="record-page">
      <Card style={{ marginBottom: 16 }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <div>
            <Typography.Text type="secondary">{t(title)}</Typography.Text>
            <Typography.Title level={3} style={{ margin: '4px 0 8px' }} data-testid="record-title">
              {record.name}
            </Typography.Title>
            <Space wrap>{summary(record, reload)}</Space>
          </div>
          <Space wrap>
            <Link href={listPath}>{t('record.back')}</Link>
          </Space>
        </Space>
        {!canEdit && perm.can('record.update.own') && <Alert type="info" showIcon title={t('record.readOnlyHint')} style={{ marginTop: 12 }} />}
      </Card>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={9}>
          <Card title={t('record.overview')} size="small">
            {fields.map((f) => (
              <InlineField
                key={`${f.key}-${tag}`}
                label={t(f.label)}
                display={f.render(record)}
                editor={f.editor}
                initial={f.value ? f.value(record) : null}
                options={f.options?.(record)}
                required={f.required}
                canEdit={canEdit && (f.editable ? f.editable(record) : true)}
                onSave={(v) => save({ [f.key]: v })}
              />
            ))}
            {customDefs.map((d) => {
              const raw = record.custom?.[d.key];
              const display = raw === undefined || raw === null || raw === '' ? null : d.type === 'CHECKBOX' ? (raw ? t('common.yes') : t('common.no')) : d.type === 'DATE' ? fmtDate(String(raw)) : String(raw);
              const options = d.type === 'CHECKBOX' ? [{ value: 'true', label: t('common.yes') }, { value: 'false', label: t('common.no') }] : d.options.map((o) => ({ value: o, label: o }));
              return (
                <InlineField
                  key={`${d.key}-${tag}`}
                  label={d.label}
                  display={display}
                  editor={customEditor(d)}
                  initial={raw === undefined || raw === null ? null : String(raw)}
                  options={options}
                  required={d.required}
                  canEdit={canEdit}
                  onSave={(v) => save({ custom: { [d.key]: d.type === 'CHECKBOX' ? v === 'true' : d.type === 'NUMBER' && v !== null ? v.trim() : v } })}
                />
              );
            })}
          </Card>
        </Col>
        <Col xs={24} lg={15}>
          <Card size="small">
            <Tabs
              items={[{ key: 'timeline', label: t('record.timeline'), children: <RecordTimeline entity={timelineEntity} id={record.id} version={tag} /> }, ...tabs(record, reload, tag)]}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
