/**
 * 列表批量操作栏：指派负责人、修改状态/阶段、标记完成、加减标签、删除。按钮按权限显示（服务端仍逐条校验）。
 * List bulk-action bar: assign owner, change status/stage, complete, add/remove tags, delete. Buttons follow permissions
 * (the server still checks every record).
 */
'use client';

import { App, Button, Popconfirm, Select, Space, Typography } from 'antd';
import { t, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { useOwners } from '@/lib/hooks';
import { usePermissions } from './AuthProvider';
import { useTags } from './Tags';

/** 服务端批量结果 / Server bulk result */
interface BulkResult {
  succeeded: string[];
  failed: { id: string; code: string; message: string }[];
}

interface Props {
  /** 资源路径，如 /api/leads / resource path */
  path: '/api/leads' | '/api/accounts' | '/api/deals' | '/api/activities';
  /** 选中的记录 ID / selected record ids */
  selected: string[];
  /** ID → 显示名称（用于失败明细）/ id → display name for failure details */
  names: Record<string, string>;
  /** 批量改值：状态（线索）或阶段（商机）/ value change: lead status or deal stage */
  valueChange?: { action: 'status' | 'stage'; field: 'status' | 'stage'; options: { value: string; label: string }[] };
  /** 跟进：批量完成 / activities: bulk complete */
  completable?: boolean;
  /** 线索/客户/商机：批量加减标签 / leads, accounts, deals: bulk add/remove tags */
  taggable?: boolean;
  /** 完成后回调（刷新列表并清空选择）/ called afterwards (reload and clear selection) */
  onDone: () => void;
  onClear: () => void;
}

export function BulkBar({ path, selected, names, valueChange, completable, taggable, onDone, onClear }: Props) {
  const { message, modal } = App.useApp();
  const perm = usePermissions();
  const owners = useOwners();
  const [tags, reloadTags] = useTags();
  const n = selected.length;
  if (n === 0) return null;

  /**
   * 调用批量接口并汇总结果；有失败时逐条列出原因。
   * Call the bulk endpoint and summarise; list each failure with its reason.
   */
  const run = async (body: Record<string, unknown>) => {
    try {
      const res = await api<BulkResult>(`${path}/bulk`, { method: 'POST', body: { ...body, ids: selected } });
      if (res.failed.length === 0) {
        message.success(t('bulk.done', { n: res.succeeded.length }));
      } else {
        modal.warning({
          title: t('bulk.partial', { ok: res.succeeded.length, fail: res.failed.length }),
          content: (
            <div data-testid="bulk-failures">
              <Typography.Text type="secondary">{t('bulk.failedTitle')}</Typography.Text>
              <ul style={{ paddingLeft: 18, marginTop: 8 }}>
                {res.failed.map((f) => (
                  <li key={f.id}>
                    {names[f.id] ?? f.id.slice(0, 8)}：{t(`error.${f.code}` as MessageKey)}
                  </li>
                ))}
              </ul>
            </div>
          ),
        });
      }
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      onDone();
    }
  };

  const confirm = (content: string, body: Record<string, unknown>) =>
    modal.confirm({ title: content, okText: t('common.save'), cancelText: t('common.cancel'), onOk: () => run(body) });

  const ownerOptions = [{ value: '', label: t('bulk.unassigned') }, ...owners.map((u) => ({ value: u.id, label: u.name }))];

  return (
    <Space wrap data-testid="bulk-bar" style={{ marginBottom: 12, padding: '8px 12px', background: '#e6f4ff', borderRadius: 6, width: '100%' }}>
      <Typography.Text strong>{t('bulk.selected', { n })}</Typography.Text>
      {perm.canAssign && (
        <Select
          aria-label={t('bulk.assign')}
          placeholder={t('bulk.assign')}
          style={{ width: 170 }}
          value={null}
          options={ownerOptions}
          onChange={(v: string) =>
            confirm(t('bulk.confirmAssign', { n, owner: ownerOptions.find((o) => o.value === v)?.label ?? '' }), {
              action: 'assign',
              ownerId: v || null,
            })
          }
        />
      )}
      {valueChange && (
        <Select
          aria-label={t(valueChange.action === 'status' ? 'bulk.status' : 'bulk.stage')}
          placeholder={t(valueChange.action === 'status' ? 'bulk.status' : 'bulk.stage')}
          style={{ width: 160 }}
          value={null}
          options={valueChange.options}
          onChange={(v: string) =>
            confirm(t('bulk.confirmValue', { n, value: valueChange.options.find((o) => o.value === v)?.label ?? v }), {
              action: valueChange.action,
              [valueChange.field]: v,
            })
          }
        />
      )}
      {taggable &&
        perm.can('record.update.own') &&
        (['tag_add', 'tag_remove'] as const).map((action) => (
          <Select
            key={action}
            aria-label={t(action === 'tag_add' ? 'tags.bulkAdd' : 'tags.bulkRemove')}
            placeholder={t(action === 'tag_add' ? 'tags.bulkAdd' : 'tags.bulkRemove')}
            style={{ width: 140 }}
            value={null}
            // 每次展开时刷新，包含刚在详情中新建的标签 / refresh on open to include tags just created elsewhere
            onOpenChange={(open) => open && void reloadTags()}
            options={tags.map((x) => ({ value: x.id, label: x.name }))}
            onChange={(v: string) =>
              confirm(t(action === 'tag_add' ? 'tags.confirmBulkAdd' : 'tags.confirmBulkRemove', { n, name: tags.find((x) => x.id === v)?.name ?? '' }), {
                action,
                tagId: v,
              })
            }
          />
        ))}
      {completable && (
        <>
          <Button size="small" onClick={() => confirm(t('bulk.confirmComplete', { n, value: t('activities.completed') }), { action: 'complete', completed: true })}>
            {t('bulk.complete')}
          </Button>
          <Button size="small" onClick={() => confirm(t('bulk.confirmComplete', { n, value: t('activities.pending') }), { action: 'complete', completed: false })}>
            {t('bulk.reopen')}
          </Button>
        </>
      )}
      {perm.canDelete && (
        <Popconfirm title={t('bulk.confirmDelete', { n })} onConfirm={() => run({ action: 'delete' })}>
          <Button size="small" danger>
            {t('bulk.delete')}
          </Button>
        </Popconfirm>
      )}
      <Button size="small" type="link" onClick={onClear}>
        {t('bulk.clear')}
      </Button>
    </Space>
  );
}
