/**
 * 下拉选项设置页（设置 › 下拉选项，需 customfield.manage）：按字段编辑选项的显示名称、启用、顺序与赢单概率，
 * 线索来源与行业可新增、删除自定义选项；保存后所有页面按新配置显示。
 * Pick-list setup (Setup › Pick lists, customfield.manage): per field, edit display names, active flags, order and win
 * probability; lead source and industry also add and remove custom options. After saving every page follows.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Input, InputNumber, Segmented, Space, Switch, Table, Tag, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { t, tEnumBuiltin, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { FIELD_PREFIX, PICKLISTS_CHANGED, type PicklistField, type PicklistOption } from '@/lib/picklists';

const FIELDS: PicklistField[] = ['LEAD_SOURCE', 'INDUSTRY', 'LEAD_STATUS', 'DEAL_STAGE', 'ACTIVITY_TYPE'];
/** 可新增选项、调整顺序的字段 / fields accepting new options and reordering */
const EXTENSIBLE = new Set<PicklistField>(['LEAD_SOURCE', 'INDUSTRY']);

/** 编辑中的一行（新选项没有代码）/ a row being edited (new options have no code) */
interface Row {
  key: string;
  value?: string;
  label: string;
  isActive: boolean;
  isCustom: boolean;
  locked: boolean;
  probability: number | null;
}

/** 内置默认名称（不受组织自定义名称影响）/ the built-in default name (ignoring organization labels) */
const builtinLabel = (field: PicklistField, value: string) => tEnumBuiltin(FIELD_PREFIX[field], value);

let seq = 0;
const toRows = (list: PicklistOption[]): Row[] => list.map((o) => ({ key: o.value, value: o.value, label: o.label ?? '', isActive: o.isActive, isCustom: o.isCustom, locked: o.locked, probability: o.probability }));

export default function PicklistsPage() {
  const { message } = App.useApp();
  const [field, setField] = useState<PicklistField>('LEAD_SOURCE');
  const [all, setAll] = useState<Record<PicklistField, PicklistOption[]> | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api<{ fields: Record<PicklistField, PicklistOption[]> }>('/api/picklists')
      .then((r) => setAll(r.fields))
      .catch((err: Error) => message.error(err.message));
  }, [message]);
  useEffect(load, [load]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setRows(all ? toRows(all[field]) : []), [all, field]);

  const extensible = EXTENSIBLE.has(field);
  const update = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const move = (index: number, delta: number) =>
    setRows((rs) => {
      const next = [...rs];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item!);
      return next;
    });
  const defaultName = (r: Row) => (r.value && !r.isCustom ? builtinLabel(field, r.value) : '');

  const save = async () => {
    setSaving(true);
    try {
      const values = rows.map((r) => ({ ...(r.value ? { value: r.value } : {}), label: r.label.trim() || null, isActive: r.isActive, ...(field === 'DEAL_STAGE' && r.probability !== null ? { probability: r.probability } : {}) }));
      await api(`/api/picklists/${field}`, { method: 'PUT', body: { values } });
      message.success(t('picklists.saved'));
      // 通知外壳重新读取配置并刷新页面 / tell the shell to reload the configuration and refresh pages
      window.dispatchEvent(new Event(PICKLISTS_CHANGED));
    } catch (err) {
      const d = err instanceof ClientApiError ? err.details : undefined;
      const codes = Object.values(d ?? {}).flat();
      const inUse = codes.find((c) => c.startsWith('in_use:'));
      if (inUse) {
        const value = inUse.slice('in_use:'.length);
        message.error(t('picklists.error.in_use', { label: all?.[field].find((o) => o.value === value)?.label ?? value }));
      } else if (codes.some((c) => ['taken', 'required', 'none_active'].includes(c))) {
        const code = codes.find((c) => ['taken', 'required', 'none_active'].includes(c))!;
        message.error(t(`picklists.error.${code}` as MessageKey));
      } else message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={t('picklists.title')}
      extra={
        <Button type="primary" loading={saving} onClick={() => void save()} data-testid="picklists-save">
          {t('picklists.save')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">{t('picklists.hint')}</Typography.Paragraph>
      <Segmented style={{ marginBottom: 16 }} value={field} onChange={(v) => setField(v as PicklistField)} options={FIELDS.map((f) => ({ value: f, label: t(`picklists.field.${f}` as MessageKey) }))} />
      <Table<Row>
        rowKey="key"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        data-testid="picklist-table"
        columns={[
          {
            title: t('picklists.default'),
            render: (_, r) => (
              <Space>
                {defaultName(r) || '—'}
                {r.isCustom && <Tag color="blue">{t('picklists.custom')}</Tag>}
              </Space>
            ),
          },
          {
            title: t('picklists.label'),
            render: (_, r) => (
              <Input
                value={r.label}
                maxLength={50}
                style={{ width: 200 }}
                placeholder={defaultName(r) || t('picklists.newLabel')}
                aria-label={`${t('picklists.label')} ${defaultName(r) || (r.value ? r.label : t('picklists.newLabel'))}`}
                onChange={(e) => update(r.key, { label: e.target.value })}
              />
            ),
          },
          { title: t('picklists.code'), render: (_, r) => (r.value ? <Typography.Text code>{r.value}</Typography.Text> : '—') },
          {
            title: t('picklists.active'),
            render: (_, r) =>
              r.locked ? (
                <Tag>{t('picklists.locked')}</Tag>
              ) : (
                <Switch size="small" checked={r.isActive} aria-label={`${t('picklists.active')} ${defaultName(r) || r.label}`} onChange={(v) => update(r.key, { isActive: v })} />
              ),
          },
          ...(field === 'DEAL_STAGE'
            ? [
                {
                  title: t('picklists.probability'),
                  render: (_: unknown, r: Row) =>
                    r.probability === null ? (
                      '—'
                    ) : (
                      <InputNumber min={0} max={100} precision={0} value={r.probability} aria-label={`${t('picklists.probability')} ${defaultName(r)}`} onChange={(v) => update(r.key, { probability: v ?? 0 })} />
                    ),
                },
              ]
            : []),
          ...(extensible
            ? [
                {
                  title: t('common.actions'),
                  render: (_: unknown, r: Row, index: number) => (
                    <Space>
                      <Button size="small" icon={<ArrowUpOutlined />} disabled={index === 0} aria-label={`${t('picklists.up')} ${defaultName(r) || r.label}`} onClick={() => move(index, -1)} />
                      <Button size="small" icon={<ArrowDownOutlined />} disabled={index === rows.length - 1} aria-label={`${t('picklists.down')} ${defaultName(r) || r.label}`} onClick={() => move(index, 1)} />
                      {(r.isCustom || !r.value) && <Button size="small" danger icon={<DeleteOutlined />} aria-label={`${t('picklists.remove')} ${r.label}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} />}
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />
      {extensible && (
        <Button style={{ marginTop: 12 }} icon={<PlusOutlined />} onClick={() => setRows((rs) => [...rs, { key: `new-${++seq}`, label: '', isActive: true, isCustom: true, locked: false, probability: null }])} data-testid="picklist-add">
          {t('picklists.add')}
        </Button>
      )}
    </Card>
  );
}
