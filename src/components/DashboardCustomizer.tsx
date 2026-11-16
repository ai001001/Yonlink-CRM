/**
 * 自定义工作台面板：勾选显示的卡片，用上移/下移调整顺序，保存到服务端或恢复默认。
 * 不使用拖拽：按钮操作可用键盘完成，也更稳定。
 * Dashboard customisation panel: tick the cards to show, reorder with move up/down, save to the server or reset.
 * No drag and drop: buttons work from the keyboard and are more reliable.
 */
'use client';

import { useState } from 'react';
import { App, Button, Checkbox, Drawer, List, Popconfirm, Space, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { t, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';

/** 全部卡片键（与服务端一致，顺序即默认顺序）/ every card key (same as the server, default order) */
export const DASHBOARD_WIDGETS = ['counts', 'dealAmounts', 'myTodos', 'myTickets', 'recentActivities', 'closingSoon', 'stages'] as const;
/** 卡片键 / Card key */
export type DashboardWidget = (typeof DASHBOARD_WIDGETS)[number];

/**
 * 父组件应在每次打开时用新的 key 重新挂载本组件，以从当前布局初始化（不在打开动画结束后重置，否则会丢掉动画期间的修改）。
 * The parent should remount this component with a new key on each open so it starts from the current layout
 * (no reset after the opening animation, which would discard edits made during it).
 */
interface Props {
  open: boolean;
  /** 当前显示的卡片（按顺序）/ cards currently shown, in order */
  current: DashboardWidget[];
  onClose: () => void;
  /** 保存或恢复默认后 / after saving or resetting */
  onSaved: () => void;
}

interface Item {
  key: DashboardWidget;
  shown: boolean;
}

/**
 * 编辑用的列表：先是显示中的卡片（按当前顺序），再是隐藏的卡片（按默认顺序）。
 * Editing list: shown cards in their current order, then hidden ones in default order.
 */
const toItems = (current: DashboardWidget[]): Item[] => [
  ...current.map((key) => ({ key, shown: true })),
  ...DASHBOARD_WIDGETS.filter((k) => !current.includes(k)).map((key) => ({ key, shown: false })),
];

export function DashboardCustomizer({ open, current, onClose, onSaved }: Props) {
  const { message } = App.useApp();
  const [items, setItems] = useState<Item[]>(() => toItems(current));
  const [saving, setSaving] = useState(false);
  const label = (k: DashboardWidget) => t(`dashboard.widget.${k}` as MessageKey);
  const shownCount = items.filter((i) => i.shown).length;

  const move = (index: number, delta: number) => {
    const next = [...items];
    const [it] = next.splice(index, 1);
    next.splice(index + delta, 0, it!);
    setItems(next);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api('/api/dashboard/layout', { method: 'PUT', body: { widgets: items.filter((i) => i.shown).map((i) => i.key) } });
      message.success(t('common.saved'));
      onSaved();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    try {
      await api('/api/dashboard/layout', { method: 'DELETE' });
      message.success(t('dashboard.layoutReset'));
      onSaved();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <Drawer
      title={t('dashboard.customize')}
      size={420}
      open={open}
      onClose={onClose}
      footer={
        <Space style={{ justifyContent: 'space-between', width: '100%' }}>
          <Popconfirm title={t('dashboard.confirmReset')} onConfirm={reset}>
            <Button>{t('dashboard.resetLayout')}</Button>
          </Popconfirm>
          <Space>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="primary" loading={saving} disabled={shownCount === 0} onClick={save}>
              {t('common.save')}
            </Button>
          </Space>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">{t('dashboard.customizeHint')}</Typography.Paragraph>
      <List
        data-testid="dashboard-widgets"
        bordered
        dataSource={items}
        renderItem={(it, i) => (
          <List.Item
            actions={[
              <Button key="up" size="small" type="text" icon={<ArrowUpOutlined />} aria-label={`${t('dashboard.moveUp')} ${label(it.key)}`} disabled={i === 0} onClick={() => move(i, -1)} />,
              <Button key="down" size="small" type="text" icon={<ArrowDownOutlined />} aria-label={`${t('dashboard.moveDown')} ${label(it.key)}`} disabled={i === items.length - 1} onClick={() => move(i, 1)} />,
            ]}
          >
            <Checkbox checked={it.shown} onChange={(e) => setItems(items.map((x) => (x.key === it.key ? { ...x, shown: e.target.checked } : x)))}>
              {label(it.key)}
            </Checkbox>
          </List.Item>
        )}
      />
      {shownCount === 0 && <Typography.Text type="danger">{t('dashboard.atLeastOne')}</Typography.Text>}
    </Drawer>
  );
}
