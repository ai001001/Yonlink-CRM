/**
 * 标签组件：标签显示、记录标签编辑（选择已有或输入新建）、列表标签筛选与标签管理弹窗（改名、改色、删除）。
 * Tag components: display, per-record editor (pick existing or type to create), list filter and the
 * management modal (rename, recolour, delete).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Input, Modal, Popconfirm, Select, Space, Table, Tag as AntTag, Typography } from 'antd';
import { PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { t, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import type { RecordTags, Tag } from '@/lib/types';
import { usePermissions } from './AuthProvider';

/** 预设颜色（与服务端一致）/ preset colours (same as the server) */
export const TAG_COLORS = ['blue', 'green', 'gold', 'red', 'purple', 'cyan', 'orange', 'magenta', 'geekblue', 'volcano'] as const;

/** 记录上的标签 → 标签数组 / record tags → tags */
export const tagsOf = (r: { tags?: RecordTags }): Tag[] => (r.tags ?? []).map((x) => x.tag);

/**
 * 标签错误提示。
 * Message for tag errors.
 */
function tagError(err: unknown): string {
  const d = err instanceof ClientApiError ? err.details : undefined;
  const code = d?.name?.[0] ?? (d?.tagIds?.[0] === 'limit' ? 'tagLimit' : undefined);
  return code ? t(`tags.error.${code}` as MessageKey) : (err as Error).message;
}

/**
 * 加载组织标签；返回列表与重新加载函数。
 * Load the organization's tags with a reload function.
 */
export function useTags(): [Tag[], () => Promise<void>] {
  const [tags, setTags] = useState<Tag[]>([]);
  const reload = useCallback(async () => {
    try {
      setTags((await api<{ items: Tag[] }>('/api/tags')).items);
    } catch {
      setTags([]);
    }
  }, []);
  useEffect(() => {
    // 首次加载 / initial load
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);
  return [tags, reload];
}

/**
 * 只读标签列表。
 * Read-only tag list.
 */
export function TagList({ tags }: { tags: Tag[] }) {
  if (!tags.length) return null;
  return (
    <Space size={[0, 4]} wrap data-testid="tag-list">
      {tags.map((tag) => (
        <AntTag key={tag.id} color={tag.color}>
          {tag.name}
        </AntTag>
      ))}
    </Space>
  );
}

interface EditorProps {
  /** 资源路径，如 /api/leads / resource path */
  path: '/api/leads' | '/api/accounts' | '/api/deals';
  record: { id: string; ownerId: string | null; tags?: RecordTags };
  /** 标签变化后 / after a change */
  onChanged?: (tags: Tag[]) => void;
}

/**
 * 记录标签编辑：显示标签（可编辑时可移除），“+ 标签”选择已有标签或输入名称新建。
 * Record tag editor: shows tags (removable when editable); “+ Tag” picks an existing tag or creates a new one.
 */
export function TagEditor({ path, record, onChanged }: EditorProps) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const editable = perm.canEdit(record);
  const [tags, setTags] = useState<Tag[]>(() => tagsOf(record));
  const [all, reloadAll] = useTags();
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');

  const save = async (ids: string[]) => {
    try {
      const r = await api<{ items: Tag[] }>(`${path}/${record.id}/tags`, { method: 'PUT', body: { tagIds: ids } });
      setTags(r.items);
      onChanged?.(r.items);
    } catch (err) {
      message.error(tagError(err));
    }
  };

  const pick = async (value: string) => {
    setAdding(false);
    setSearch('');
    if (value.startsWith('new:')) {
      try {
        const created = await api<Tag>('/api/tags', { method: 'POST', body: { name: value.slice(4) } });
        void reloadAll();
        await save([...tags.map((x) => x.id), created.id]);
      } catch (err) {
        message.error(tagError(err));
      }
      return;
    }
    await save([...tags.map((x) => x.id), value]);
  };

  const term = search.trim();
  const exists = all.some((x) => x.name.toLowerCase() === term.toLowerCase());
  const options = [
    ...all.filter((x) => !tags.some((y) => y.id === x.id)).map((x) => ({ value: x.id, label: <AntTag color={x.color}>{x.name}</AntTag>, name: x.name })),
    ...(term && !exists && term.length <= 30 ? [{ value: `new:${term}`, label: t('tags.create', { name: term }), name: term }] : []),
  ];

  return (
    <Space size={[0, 4]} wrap data-testid="tag-editor">
      {tags.map((tag) => (
        <AntTag
          key={tag.id}
          color={tag.color}
          closable={editable}
          onClose={(e) => {
            e.preventDefault();
            void save(tags.filter((x) => x.id !== tag.id).map((x) => x.id));
          }}
        >
          {tag.name}
        </AntTag>
      ))}
      {editable &&
        (adding ? (
          <Select
            autoFocus
            open
            size="small"
            aria-label={t('tags.add')}
            style={{ width: 200 }}
            placeholder={t('tags.addPlaceholder')}
            showSearch={{ filterOption: (input, option) => String(option?.name ?? '').toLowerCase().includes(input.trim().toLowerCase()), onSearch: setSearch }}
            options={options}
            value={null}
            onChange={(v: string) => void pick(v)}
            onBlur={() => {
              setAdding(false);
              setSearch('');
            }}
          />
        ) : (
          <AntTag style={{ borderStyle: 'dashed', cursor: 'pointer', background: '#fff' }} onClick={() => setAdding(true)} icon={<PlusOutlined />}>
            {t('tags.add')}
          </AntTag>
        ))}
    </Space>
  );
}

/**
 * 标签管理弹窗：新建、改名、改色、删除（需 tag.manage）。
 * Tag management modal: create, rename, recolour, delete (tag.manage).
 */
function TagManager({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const { message } = App.useApp();
  const [tags, reload] = useTags();
  const [name, setName] = useState('');

  useEffect(() => {
    // 每次打开时重新加载（含刚新建的标签与最新使用次数）/ reload on open (new tags, fresh counts)
    if (open) void reload();
  }, [open, reload]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
      onChanged();
    } catch (err) {
      message.error(tagError(err));
    }
  };

  return (
    <Modal title={t('tags.manageTitle')} open={open} onCancel={onClose} footer={null} width={640} zIndex={1100}>
      <Typography.Paragraph type="secondary">{t('tags.manageHint')}</Typography.Paragraph>
      <Space.Compact style={{ marginBottom: 12, width: '100%' }}>
        <Input aria-label={t('tags.newName')} placeholder={t('tags.newName')} maxLength={30} value={name} onChange={(e) => setName(e.target.value)} />
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={!name.trim()}
          onClick={() =>
            run(async () => {
              await api('/api/tags', { method: 'POST', body: { name } });
              setName('');
            })
          }
        >
          {t('common.add')}
        </Button>
      </Space.Compact>
      <Table<Tag>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={tags}
        locale={{ emptyText: t('tags.empty') }}
        columns={[
          {
            title: t('tags.name'),
            render: (_, r) => (
              <Input
                size="small"
                aria-label={`${t('tags.name')} ${r.name}`}
                defaultValue={r.name}
                maxLength={30}
                onBlur={(e) => e.target.value.trim() !== r.name && void run(() => api(`/api/tags/${r.id}`, { method: 'PATCH', body: { name: e.target.value } }))}
              />
            ),
          },
          {
            title: t('tags.color'),
            width: 150,
            render: (_, r) => (
              <Select
                size="small"
                aria-label={`${t('tags.color')} ${r.name}`}
                style={{ width: 130 }}
                value={r.color}
                onChange={(color: string) => run(() => api(`/api/tags/${r.id}`, { method: 'PATCH', body: { color } }))}
                options={TAG_COLORS.map((c) => ({ value: c, label: <AntTag color={c}>{r.name}</AntTag> }))}
              />
            ),
          },
          {
            title: t('tags.usage'),
            render: (_, r) => <Typography.Text type="secondary">{t('tags.usageDetail', { leads: r._count?.leads ?? 0, accounts: r._count?.accounts ?? 0, deals: r._count?.deals ?? 0 })}</Typography.Text>,
          },
          {
            title: t('common.actions'),
            width: 70,
            render: (_, r) => (
              <Popconfirm
                title={t('tags.confirmDelete', { name: r.name, count: (r._count?.leads ?? 0) + (r._count?.accounts ?? 0) + (r._count?.deals ?? 0) })}
                onConfirm={() => run(() => api(`/api/tags/${r.id}`, { method: 'DELETE' }))}
              >
                <Button type="link" size="small" danger>
                  {t('common.delete')}
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </Modal>
  );
}

/**
 * 列表标签筛选（含“管理标签”入口）。
 * List tag filter with the “Manage tags” entry.
 */
export function TagFilter({ value, onChange, onManaged }: { value?: string; onChange: (v: string | undefined) => void; onManaged?: () => void }) {
  const perm = usePermissions();
  const [tags, reload] = useTags();
  const [managing, setManaging] = useState(false);
  return (
    <Space size={4}>
      <Select
        allowClear
        aria-label={t('tags.filter')}
        placeholder={t('tags.filter')}
        style={{ width: 150 }}
        value={value}
        onChange={onChange}
        onOpenChange={(open) => open && void reload()}
        options={tags.map((x) => ({ value: x.id, label: <AntTag color={x.color}>{x.name}</AntTag>, title: x.name }))}
      />
      {perm.can('tag.manage') && (
        <>
          <Button aria-label={t('tags.manage')} title={t('tags.manage')} icon={<SettingOutlined />} onClick={() => setManaging(true)} />
          <TagManager
            open={managing}
            onClose={() => setManaging(false)}
            onChanged={() => {
              void reload();
              onManaged?.();
            }}
          />
        </>
      )}
    </Space>
  );
}
