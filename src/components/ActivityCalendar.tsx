/**
 * 跟进日历：月视图（6 周网格）与周视图，按截止时间显示跟进；点击日期查看当天列表并可在当天新建；
 * 可把跟进拖到其他日期（保留原时间点，需有编辑权限）。日期按浏览器本地时区显示。
 * Activity calendar: month view (6-week grid) and week view by due time; clicking a day lists its items and
 * allows creating one on that day; items can be dragged to another day (time of day kept; edit rights required).
 * Dates use the browser's local time zone.
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Empty, List, Segmented, Select, Space, Spin, Tag, Typography } from 'antd';
import { LeftOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, qs } from '@/lib/api';
import { useOwners } from '@/lib/hooks';
import type { Activity } from '@/lib/types';
import { activityTypeOptions } from './ActivityFormModal';
import { usePermissions } from './AuthProvider';
import { ACTIVITY_TYPE_COLOR } from './RelatedActivities';

type Mode = 'month' | 'week';
type StatusFilter = 'all' | 'false' | 'true';

/** 类型颜色（日历色块）/ type colours for calendar chips */
const CHIP_COLOR: Record<string, string> = {
  CALL: '#1f5fbf',
  MEETING: '#722ed1',
  VISIT: '#d46b08',
  TASK: '#08979c',
};
/** 月视图每格最多显示条数 / items shown per month cell */
const PER_CELL = 3;

/**
 * 某天所在周的周一。
 * Monday of the week containing the day.
 */
export function mondayOf(d: Dayjs): Dayjs {
  return d.startOf('day').subtract((d.day() + 6) % 7, 'day');
}

/**
 * 视图的日期范围：月视图为包含该月的 6 周（42 天），周视图为 7 天。
 * Visible days: 6 weeks (42 days) around the month, or 7 days for the week view.
 */
export function visibleDays(mode: Mode, anchor: Dayjs): Dayjs[] {
  const start = mode === 'month' ? mondayOf(anchor.startOf('month')) : mondayOf(anchor);
  return Array.from({ length: mode === 'month' ? 42 : 7 }, (_, i) => start.add(i, 'day'));
}

/** 是否逾期 / overdue */
const overdue = (a: Activity) => !a.completed && !!a.dueAt && dayjs(a.dueAt).isBefore(dayjs());

interface Props {
  /** 打开详情 / open the detail */
  onOpen: (a: Activity) => void;
  /** 在某天新建（默认 09:00）/ create on a day (09:00 by default) */
  onCreate: (dueAt: Dayjs) => void;
  /** 外部数据变化时递增以重新加载 / bump to reload after external changes */
  version: number;
}

export function ActivityCalendar({ onOpen, onCreate, version }: Props) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const owners = useOwners();
  const [mode, setMode] = useState<Mode>('month');
  const [anchor, setAnchor] = useState(() => dayjs());
  const [selected, setSelected] = useState(() => dayjs().format('YYYY-MM-DD'));
  const [type, setType] = useState<string>();
  const [ownerId, setOwnerId] = useState<string>();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [items, setItems] = useState<Activity[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);

  const days = useMemo(() => visibleDays(mode, anchor), [mode, anchor]);

  useEffect(() => {
    let alive = true;
    // 视图或筛选变化时加载 / load when the view or filters change
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    const from = days[0]!;
    const to = days[days.length - 1]!.add(1, 'day');
    api<{ items: Activity[]; truncated: boolean }>(
      `/api/activities/calendar${qs({ from: from.toISOString(), to: to.toISOString(), type, ownerId, completed: status === 'all' ? undefined : status })}`,
    )
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setTruncated(r.truncated);
      })
      .catch((err: unknown) => message.error((err as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [days, type, ownerId, status, version, reload, message]);

  // 按本地日期分组 / group by local date
  const byDay = useMemo(() => {
    const map = new Map<string, Activity[]>();
    for (const a of items) {
      const key = dayjs(a.dueAt).format('YYYY-MM-DD');
      map.set(key, [...(map.get(key) ?? []), a]);
    }
    return map;
  }, [items]);

  /**
   * 拖到另一天：保留原时间点。
   * Drop on another day keeping the time of day.
   */
  const move = useCallback(
    async (id: string, day: Dayjs) => {
      const a = items.find((x) => x.id === id);
      if (!a?.dueAt) return;
      const old = dayjs(a.dueAt);
      if (old.format('YYYY-MM-DD') === day.format('YYYY-MM-DD')) return;
      const next = day.hour(old.hour()).minute(old.minute()).second(old.second()).millisecond(old.millisecond());
      try {
        await api(`/api/activities/${id}`, {
          method: 'PATCH',
          body: { dueAt: next.toISOString() },
        });
        message.success(t('calendar.moved', { date: next.format('YYYY-MM-DD') }));
        setReload((v) => v + 1);
      } catch (err) {
        message.error((err as Error).message);
      }
    },
    [items, message],
  );

  const step = (dir: 1 | -1) => setAnchor((d) => d.add(dir, mode === 'month' ? 'month' : 'week'));
  const title =
    mode === 'month'
      ? t('calendar.monthTitle', {
          year: anchor.year(),
          month: anchor.month() + 1,
        })
      : `${days[0]!.format('YYYY-MM-DD')} ~ ${days[6]!.format('YYYY-MM-DD')}`;
  const today = dayjs().format('YYYY-MM-DD');
  const dayItems = byDay.get(selected) ?? [];

  /** 日历色块 / calendar chip */
  const chip = (a: Activity) => {
    const draggable = perm.canEdit(a);
    return (
      <div
        key={a.id}
        role="button"
        tabIndex={0}
        data-testid="calendar-item"
        data-id={a.id}
        draggable={draggable}
        onDragStart={(e) => e.dataTransfer.setData('text/plain', a.id)}
        onClick={(e) => {
          e.stopPropagation();
          onOpen(a);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onOpen(a);
        }}
        title={`${dayjs(a.dueAt).format('HH:mm')} ${tEnum('activityType', a.type)} · ${a.subject}${a.owner ? ` · ${a.owner.name}` : ''}`}
        style={{
          fontSize: 12,
          lineHeight: '18px',
          padding: '1px 4px',
          marginTop: 2,
          borderRadius: 3,
          borderLeft: `3px solid ${CHIP_COLOR[a.type]}`,
          background: overdue(a) ? '#fff1f0' : '#f4f7fc',
          color: a.completed ? '#8c8c8c' : undefined,
          textDecoration: a.completed ? 'line-through' : undefined,
          cursor: draggable ? 'grab' : 'pointer',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {dayjs(a.dueAt).format('HH:mm')} {a.subject}
      </div>
    );
  };

  return (
    <div data-testid="activity-calendar">
      <Space
        wrap
        style={{
          marginBottom: 12,
          width: '100%',
          justifyContent: 'space-between',
        }}
      >
        <Space wrap>
          <Button onClick={() => setAnchor(dayjs())}>{t('calendar.today')}</Button>
          <Button aria-label={t('calendar.prev')} icon={<LeftOutlined />} onClick={() => step(-1)} />
          <Button aria-label={t('calendar.next')} icon={<RightOutlined />} onClick={() => step(1)} />
          <Typography.Text strong data-testid="calendar-title" style={{ fontSize: 16 }}>
            {title}
          </Typography.Text>
        </Space>
        <Space wrap>
          <Segmented<StatusFilter>
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: t('common.all') },
              { value: 'false', label: t('activities.pending') },
              { value: 'true', label: t('activities.completed') },
            ]}
          />
          <Select
            aria-label={t('activities.type')}
            allowClear
            placeholder={t('activities.type')}
            style={{ width: 120 }}
            options={activityTypeOptions}
            value={type}
            onChange={setType}
          />
          {perm.can('record.read.all') && (
            <Select
              aria-label={t('common.owner')}
              allowClear
              placeholder={t('calendar.allOwners')}
              style={{ width: 140 }}
              options={owners.map((u) => ({ value: u.id, label: u.name }))}
              value={ownerId}
              onChange={setOwnerId}
            />
          )}
          <Segmented<Mode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'month', label: t('calendar.month') },
              { value: 'week', label: t('calendar.week') },
            ]}
          />
        </Space>
      </Space>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        {t('calendar.noDueHint')}
      </Typography.Paragraph>
      {truncated && <Alert type="warning" showIcon title={t('calendar.truncated', { limit: 1000 })} style={{ marginBottom: 8 }} />}
      <Spin spinning={loading}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
            border: '1px solid #e8ecf2',
            borderRadius: 6,
            overflow: 'hidden',
          }}
        >
          {[1, 2, 3, 4, 5, 6, 7].map((w) => (
            <div
              key={w}
              style={{
                padding: '6px 8px',
                background: '#f7f9fc',
                fontSize: 12,
                color: '#5b6475',
                borderBottom: '1px solid #e8ecf2',
              }}
            >
              {t(`calendar.weekday.${w}` as MessageKey)}
            </div>
          ))}
          {days.map((d) => {
            const key = d.format('YYYY-MM-DD');
            const list = byDay.get(key) ?? [];
            const shown = mode === 'month' ? list.slice(0, PER_CELL) : list;
            const outside = mode === 'month' && d.month() !== anchor.month();
            return (
              <div
                key={key}
                data-testid="calendar-day"
                data-date={key}
                role="gridcell"
                aria-selected={selected === key}
                onClick={() => setSelected(key)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = e.dataTransfer.getData('text/plain');
                  if (id) void move(id, d);
                }}
                style={{
                  minHeight: mode === 'month' ? 96 : 320,
                  padding: 4,
                  borderTop: '1px solid #e8ecf2',
                  borderLeft: '1px solid #e8ecf2',
                  background: selected === key ? '#eef4ff' : outside ? '#fafbfc' : '#fff',
                  cursor: 'pointer',
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    color: outside ? '#b0b7c3' : '#33394a',
                    fontWeight: key === today ? 700 : 400,
                  }}
                >
                  {key === today ? (
                    <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                      {d.date()}
                    </Tag>
                  ) : mode === 'week' ? (
                    d.format('MM-DD')
                  ) : (
                    d.date()
                  )}
                </div>
                {shown.map(chip)}
                {list.length > shown.length && (
                  <Typography.Link style={{ fontSize: 12 }} onClick={() => setSelected(key)}>
                    {t('calendar.more', { count: list.length - shown.length })}
                  </Typography.Link>
                )}
              </div>
            );
          })}
        </div>
      </Spin>
      <Card
        size="small"
        style={{ marginTop: 12 }}
        title={t('calendar.dayTitle', { date: selected })}
        data-testid="calendar-agenda"
        extra={
          perm.canCreate && (
            <Button size="small" icon={<PlusOutlined />} onClick={() => onCreate(dayjs(selected).hour(9).minute(0))}>
              {t('calendar.newOnDay')}
            </Button>
          )
        }
      >
        {dayItems.length ? (
          <List
            size="small"
            dataSource={dayItems}
            renderItem={(a) => (
              <List.Item>
                <Space wrap>
                  <Typography.Text type="secondary">{dayjs(a.dueAt).format('HH:mm')}</Typography.Text>
                  <Tag color={ACTIVITY_TYPE_COLOR[a.type]}>{tEnum('activityType', a.type)}</Tag>
                  <Typography.Link onClick={() => onOpen(a)} delete={a.completed}>
                    {a.subject}
                  </Typography.Link>
                  {overdue(a) && <Tag color="red">{t('activities.overdue')}</Tag>}
                  {a.completed && <Tag color="green">{t('activities.completed')}</Tag>}
                  <Typography.Text type="secondary">{a.owner?.name ?? t('common.unassigned')}</Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('calendar.dayEmpty')} />
        )}
      </Card>
    </div>
  );
}
