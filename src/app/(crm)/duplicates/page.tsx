/**
 * 查重合并页：按线索/客户查找疑似重复的记录组（显示匹配依据与相关数据数量），管理员与经理可合并：
 * 选择主记录并逐字段选择保留值，相关数据转到主记录，被合并的记录移入回收站。
 * Duplicates page: possible duplicate groups of leads or accounts (match reasons and related counts); admins and
 * managers merge them by choosing a master and a value per field; related data moves to the master and the merged
 * records go to the recycle bin.
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Alert, App, Button, Card, Empty, Modal, Radio, Segmented, Space, Spin, Table, Tag, Typography } from 'antd';
import { usePermissions } from '@/components/AuthProvider';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

type Entity = 'leads' | 'accounts';

/** 组内记录摘要 / record summary in a group */
interface Summary {
  id: string;
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  website?: string | null;
  industry?: string | null;
  status?: string;
  createdAt: string;
  owner: { id: string; name: string } | null;
  _count: Record<string, number>;
}

/** 重复组 / duplicate group */
interface Group {
  reasons: string[];
  records: Summary[];
}

/** 完整记录（详情接口）/ full record from the detail endpoint */
type Full = Record<string, unknown> & { id: string; owner: { id: string; name: string } | null };

const FIELDS: Record<Entity, { field: string; label: MessageKey; enumPrefix?: string }[]> = {
  leads: [
    { field: 'name', label: 'leads.name' },
    { field: 'company', label: 'leads.company' },
    { field: 'title', label: 'leads.jobTitle' },
    { field: 'phone', label: 'leads.phone' },
    { field: 'mobile', label: 'leads.mobile' },
    { field: 'email', label: 'leads.email' },
    { field: 'source', label: 'leads.source', enumPrefix: 'leadSource' },
    { field: 'status', label: 'leads.status', enumPrefix: 'leadStatus' },
    { field: 'description', label: 'common.description' },
    { field: 'ownerId', label: 'common.owner' },
  ],
  accounts: [
    { field: 'name', label: 'accounts.name' },
    { field: 'industry', label: 'accounts.industry', enumPrefix: 'industry' },
    { field: 'phone', label: 'accounts.phone' },
    { field: 'website', label: 'accounts.website' },
    { field: 'address', label: 'accounts.address' },
    { field: 'description', label: 'common.description' },
    { field: 'ownerId', label: 'common.owner' },
  ],
};

/** 是否为空值 / empty value */
const isEmpty = (v: unknown) => v === null || v === undefined || v === '';

/**
 * 合并弹窗：选择主记录与每个字段的保留值。
 * Merge dialog: choose the master and the value kept for each field.
 */
function MergeModal({ entity, group, onClose, onMerged }: { entity: Entity; group: Group; onClose: () => void; onMerged: () => void }) {
  const { message, notification } = App.useApp();
  const [records, setRecords] = useState<Full[] | null>(null);
  const [masterId, setMasterId] = useState(group.records[0]!.id);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const defs = FIELDS[entity];

  useEffect(() => {
    Promise.all(group.records.map((r) => api<Full>(`/api/${entity}/${r.id}`)))
      .then(setRecords)
      .catch((err: unknown) => message.error((err as Error).message));
  }, [entity, group, message]);

  // 默认：主记录的值；主记录为空时取第一条有值的记录 / default: the master's value, else the first non-empty one
  const defaults = useMemo(() => {
    if (!records) return {};
    const master = records.find((r) => r.id === masterId)!;
    return Object.fromEntries(defs.map((d) => [d.field, isEmpty(master[d.field]) ? (records.find((r) => !isEmpty(r[d.field]))?.id ?? masterId) : masterId]));
  }, [records, masterId, defs]);
  const chosen = { ...defaults, ...choice };

  const display = (r: Full, d: (typeof defs)[number]) => {
    const v = r[d.field];
    if (d.field === 'ownerId') return r.owner?.name ?? t('common.unassigned');
    if (isEmpty(v)) return <Typography.Text type="secondary">{t('duplicates.empty')}</Typography.Text>;
    return d.enumPrefix ? tEnum(d.enumPrefix, String(v)) : String(v);
  };

  const submit = async () => {
    setSaving(true);
    try {
      const duplicateIds = group.records.map((r) => r.id).filter((id) => id !== masterId);
      const fields = Object.fromEntries(Object.entries(chosen).filter(([, src]) => src !== masterId));
      const r = await api<{ masterId: string; merged: number }>('/api/duplicates/merge', { method: 'POST', body: { entity, masterId, duplicateIds, fields } });
      notification.success({
        title: t('duplicates.merged', { n: r.merged }),
        description: <Link href={`/${entity}?id=${r.masterId}`}>{t('duplicates.view')}</Link>,
      });
      onMerged();
    } catch (err) {
      const d = err instanceof ClientApiError ? err.details : undefined;
      message.error(d?.ids ? t('duplicates.error.converted') : d?.tags ? t('duplicates.error.tags') : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      width={Math.min(1100, 260 + group.records.length * 220)}
      title={t('duplicates.mergeTitle')}
      onCancel={onClose}
      onOk={submit}
      okText={t('duplicates.confirm', { n: group.records.length - 1 })}
      okButtonProps={{ loading: saving, disabled: !records }}
      zIndex={1100}
    >
      <Alert type="info" showIcon title={t('duplicates.mergeHint')} style={{ marginBottom: 12 }} />
      {!records ? (
        <Spin />
      ) : (
        <Table
          data-testid="merge-table"
          size="small"
          pagination={false}
          rowKey="field"
          scroll={{ x: 'max-content' }}
          dataSource={[{ field: '__master' }, ...defs]}
          columns={[
            { title: t('duplicates.field'), render: (_, d) => (d.field === '__master' ? <Typography.Text strong>{t('duplicates.master')}</Typography.Text> : t((d as (typeof defs)[number]).label)) },
            ...records.map((r) => ({
              title: String(r.name),
              key: r.id,
              render: (_: unknown, d: { field: string }) =>
                d.field === '__master' ? (
                  <Radio
                    aria-label={`${t('duplicates.master')} ${String(r.name)}`}
                    checked={masterId === r.id}
                    onChange={() => {
                      setMasterId(r.id);
                      setChoice({});
                    }}
                  >
                    {t('duplicates.master')}
                  </Radio>
                ) : (
                  <Radio checked={chosen[d.field] === r.id} onChange={() => setChoice((c) => ({ ...c, [d.field]: r.id }))}>
                    {display(r, d as (typeof defs)[number])}
                  </Radio>
                ),
            })),
          ]}
        />
      )}
    </Modal>
  );
}

export default function DuplicatesPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canMerge = perm.canDelete;
  const [entity, setEntity] = useState<Entity>('leads');
  const [data, setData] = useState<{ groups: Group[]; scanned: number; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState<Group | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api(`/api/duplicates?entity=${entity}`));
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [entity, message]);

  useEffect(() => {
    // 切换对象时加载 / load when the entity changes
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const related = (r: Summary) =>
    entity === 'leads'
      ? t('duplicates.relatedLead', { notes: r._count.notes ?? 0, activities: r._count.activities ?? 0, attachments: r._count.attachments ?? 0 })
      : t('duplicates.relatedAccount', { contacts: r._count.contacts ?? 0, deals: r._count.deals ?? 0, notes: r._count.notes ?? 0, activities: r._count.activities ?? 0, attachments: r._count.attachments ?? 0 });

  return (
    <Card title={t('duplicates.title')}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented<Entity>
          value={entity}
          onChange={setEntity}
          options={[
            { value: 'leads', label: t('nav.leads') },
            { value: 'accounts', label: t('nav.accounts') },
          ]}
        />
        {data && (
          <Typography.Text type="secondary">
            {t('duplicates.groups', { n: data.groups.length })} · {data.truncated ? t('duplicates.truncated', { n: data.scanned }) : t('duplicates.scanned', { n: data.scanned })}
          </Typography.Text>
        )}
      </Space>
      <Alert
        type="info"
        showIcon
        title={`${t(entity === 'leads' ? 'duplicates.hintLeads' : 'duplicates.hintAccounts')}${canMerge ? '' : t('duplicates.viewOnly')}`}
        style={{ marginBottom: 16 }}
      />
      <Spin spinning={loading}>
        {data && !data.groups.length && <Empty description={t('duplicates.none')} />}
        <Space orientation="vertical" style={{ width: '100%' }} size={16}>
          {data?.groups.map((g) => {
            const converted = g.records.some((r) => r.status === 'CONVERTED');
            return (
              <Card
                key={g.records.map((r) => r.id).join()}
                size="small"
                data-testid="duplicate-group"
                title={
                  <Space wrap>
                    {g.reasons.map((x) => (
                      <Tag key={x} color="orange">
                        {t(`duplicates.reason.${x}` as MessageKey)}
                      </Tag>
                    ))}
                  </Space>
                }
                extra={
                  canMerge && (
                    <Button type="primary" size="small" disabled={converted} title={converted ? t('duplicates.error.converted') : undefined} onClick={() => setMerging(g)}>
                      {t('duplicates.merge')}
                    </Button>
                  )
                }
              >
                <Table<Summary>
                  size="small"
                  rowKey="id"
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                  dataSource={g.records}
                  columns={[
                    { title: t(entity === 'leads' ? 'leads.name' : 'accounts.name'), dataIndex: 'name' },
                    ...(entity === 'leads'
                      ? [
                          { title: t('leads.company'), dataIndex: 'company' },
                          { title: t('leads.email'), dataIndex: 'email' },
                          { title: t('leads.mobile'), render: (_: unknown, r: Summary) => r.mobile ?? r.phone },
                          { title: t('leads.status'), render: (_: unknown, r: Summary) => tEnum('leadStatus', r.status) },
                        ]
                      : [
                          { title: t('accounts.industry'), render: (_: unknown, r: Summary) => tEnum('industry', r.industry) },
                          { title: t('accounts.phone'), dataIndex: 'phone' },
                          { title: t('accounts.website'), dataIndex: 'website' },
                        ]),
                    { title: t('common.owner'), render: (_, r) => r.owner?.name ?? t('common.unassigned') },
                    { title: t('duplicates.related'), render: (_, r) => <Typography.Text type="secondary">{related(r)}</Typography.Text> },
                    { title: t('common.createdAt'), render: (_, r) => fmtDateTime(r.createdAt) },
                  ]}
                />
              </Card>
            );
          })}
        </Space>
      </Spin>
      {merging && (
        <MergeModal
          entity={entity}
          group={merging}
          onClose={() => setMerging(null)}
          onMerged={() => {
            setMerging(null);
            void load();
          }}
        />
      )}
    </Card>
  );
}
