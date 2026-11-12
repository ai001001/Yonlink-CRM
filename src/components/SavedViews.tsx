/**
 * 视图切换栏：选择视图套用筛选条件；另存为视图、更新视图、设为默认、重命名、共享/取消共享、删除。
 * 打开列表时自动套用“我的默认视图”。
 * Saved-view bar: pick a view to apply its filters; save as, update, set default, rename, share/unshare, delete.
 * The user's default view is applied when the list opens.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Checkbox, Dropdown, Form, Input, Modal, Select, Space, Switch, Tag } from 'antd';
import { DownOutlined, SaveOutlined } from '@ant-design/icons';
import { t, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { usePermissions } from './AuthProvider';

/** 视图所属列表 / view lists */
export type ViewEntity = 'leads' | 'accounts' | 'deals' | 'activities';
/** 筛选条件 / filters */
export type ViewFilters = Record<string, string | undefined>;

/** 视图 / Saved view */
interface SavedView {
  id: string;
  name: string;
  filters: Record<string, string>;
  shared: boolean;
  ownerId: string;
  owner: { id: string; name: string };
}

/** 去掉空值，便于比较 / drop empty values for comparison */
const clean = (f: ViewFilters) => Object.fromEntries(Object.entries(f).filter((e): e is [string, string] => !!e[1]));
const same = (a: ViewFilters, b: ViewFilters) => {
  const x = clean(a);
  const y = clean(b);
  return Object.keys(x).length === Object.keys(y).length && Object.entries(x).every(([k, v]) => y[k] === v);
};

/** 视图错误提示 / messages for view errors */
function viewError(err: unknown): string {
  const code = err instanceof ClientApiError ? err.details?.name?.[0] : undefined;
  return code ? t(`views.error.${code}` as MessageKey) : (err as Error).message;
}

interface Props {
  entity: ViewEntity;
  /** 当前筛选条件 / current filters */
  filters: ViewFilters;
  /** 套用视图的筛选条件；null 表示恢复列表默认筛选 / apply a view's filters; null resets to the list defaults */
  onApply: (filters: Record<string, string> | null) => void;
}

export function SavedViews({ entity, filters, onApply }: Props) {
  const { message, modal } = App.useApp();
  const perm = usePermissions();
  const canShare = perm.can('view.share');
  const [views, setViews] = useState<SavedView[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [current, setCurrent] = useState<string>('');
  const [saving, setSaving] = useState<'new' | 'rename' | null>(null);
  const [form] = Form.useForm<{ name: string; shared?: boolean; makeDefault?: boolean }>();
  const applied = useRef(false);

  const load = useCallback(async () => {
    const r = await api<{ items: SavedView[]; defaultViewId: string | null }>(`/api/views?entity=${entity}`);
    setViews(r.items);
    setDefaultId(r.defaultViewId);
    return r;
  }, [entity]);

  useEffect(() => {
    // 首次加载时套用默认视图 / apply the default view on first load
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
      .then((r) => {
        if (applied.current) return;
        applied.current = true;
        const def = r.items.find((v) => v.id === r.defaultViewId);
        if (def) {
          setCurrent(def.id);
          onApply(def.filters);
        }
      })
      .catch(() => undefined);
    // 只在首次挂载时执行 / first mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const view = views.find((v) => v.id === current);
  const mine = !!view && view.ownerId === perm.meId;
  const dirty = !!view && !same(view.filters, filters);

  const pick = (id: string) => {
    setCurrent(id);
    const v = views.find((x) => x.id === id);
    onApply(v ? v.filters : null);
  };

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      message.success(ok);
      await load();
    } catch (err) {
      message.error(viewError(err));
    }
  };

  const submit = async () => {
    const v = await form.validateFields();
    if (saving === 'rename' && view) {
      await run(() => api(`/api/views/${view.id}`, { method: 'PATCH', body: { name: v.name } }), t('views.saved'));
      setSaving(null);
      return;
    }
    try {
      const created = await api<SavedView>('/api/views', { method: 'POST', body: { entity, name: v.name, filters: clean(filters), shared: !!v.shared } });
      if (v.makeDefault) await api('/api/views/default', { method: 'PUT', body: { entity, viewId: created.id } });
      message.success(t('views.saved'));
      await load();
      setCurrent(created.id);
      setSaving(null);
    } catch (err) {
      message.error(viewError(err));
    }
  };

  const option = (v: SavedView) => ({
    value: v.id,
    title: v.name,
    label: (
      <Space size={4}>
        {v.name}
        {v.id === defaultId && <Tag color="blue">{t('views.defaultMark')}</Tag>}
        {v.shared && v.ownerId !== perm.meId && <Tag>{t('views.sharedBy', { name: v.owner.name })}</Tag>}
      </Space>
    ),
  });
  const own = views.filter((v) => v.ownerId === perm.meId);
  const shared = views.filter((v) => v.ownerId !== perm.meId);

  const menu = view
    ? [
        view.id === defaultId
          ? { key: 'undefault', label: t('views.clearDefault'), onClick: () => run(() => api('/api/views/default', { method: 'PUT', body: { entity, viewId: null } }), t('views.defaultCleared')) }
          : { key: 'default', label: t('views.setDefault'), onClick: () => run(() => api('/api/views/default', { method: 'PUT', body: { entity, viewId: view.id } }), t('views.defaultSet')) },
        ...(mine
          ? [
              {
                key: 'rename',
                label: t('views.rename'),
                onClick: () => {
                  form.setFieldsValue({ name: view.name });
                  setSaving('rename');
                },
              },
            ]
          : []),
        ...(mine && canShare
          ? [
              {
                key: 'share',
                label: view.shared ? t('views.unshare') : t('views.share'),
                onClick: () => run(() => api(`/api/views/${view.id}`, { method: 'PATCH', body: { shared: !view.shared } }), t('views.saved')),
              },
            ]
          : []),
        ...(mine || (view.shared && canShare)
          ? [
              {
                key: 'delete',
                danger: true,
                label: t('views.delete'),
                onClick: () =>
                  modal.confirm({
                    title: t('views.confirmDelete', { name: view.name }),
                    okText: t('common.delete'),
                    cancelText: t('common.cancel'),
                    onOk: () =>
                      run(async () => {
                        await api(`/api/views/${view.id}`, { method: 'DELETE' });
                        setCurrent('');
                      }, t('common.deleted')),
                  }),
              },
            ]
          : []),
      ]
    : [];

  return (
    <Space wrap data-testid="saved-views">
      <Select
        aria-label={t('views.label')}
        style={{ minWidth: 200 }}
        value={current}
        onChange={pick}
        onOpenChange={(open) => open && void load()}
        options={[
          { value: '', label: t('views.all'), title: t('views.all') },
          ...(own.length ? [{ label: t('views.mine'), title: t('views.mine'), options: own.map(option) }] : []),
          ...(shared.length ? [{ label: t('views.shared'), title: t('views.shared'), options: shared.map(option) }] : []),
        ]}
      />
      {mine && dirty && (
        <Button onClick={() => run(() => api(`/api/views/${view.id}`, { method: 'PATCH', body: { filters: clean(filters) } }), t('views.updated'))}>
          {t('views.update')}
        </Button>
      )}
      <Button
        icon={<SaveOutlined />}
        onClick={() => {
          form.resetFields();
          setSaving('new');
        }}
      >
        {t('views.saveAs')}
      </Button>
      {view && (
        <Dropdown menu={{ items: menu }} trigger={['click']}>
          <Button aria-label={t('views.more')} icon={<DownOutlined />} />
        </Dropdown>
      )}
      <Modal title={saving === 'rename' ? t('views.rename') : t('views.saveAs')} open={saving !== null} onOk={submit} onCancel={() => setSaving(null)} okText={t('common.save')} forceRender zIndex={1100}>
        <Form form={form} name={`view-${entity}`} layout="vertical">
          <Form.Item name="name" label={t('views.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('views.name') }) }]}>
            <Input maxLength={50} />
          </Form.Item>
          {saving === 'new' && canShare && (
            <Form.Item name="shared" label={t('views.sharedSwitch')} valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
          {saving === 'new' && (
            <Form.Item name="makeDefault" valuePropName="checked">
              <Checkbox>{t('views.makeDefault')}</Checkbox>
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Space>
  );
}
