/**
 * 跟进管理页：电话/会议/拜访/任务，完成状态，关联客户/线索/商机。
 * Activities page: calls / meetings / visits / tasks, completion, related records.
 */
'use client';

import { useCallback, useState } from 'react';
import { App, Button, Card, Checkbox, Descriptions, Drawer, Input, Popconfirm, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { ActivityCalendar } from '@/components/ActivityCalendar';
import { ActivityFormModal, activityTypeOptions } from '@/components/ActivityFormModal';
import { ActivityRelationFields } from '@/components/ActivityRelationFields';
import { usePermissions } from '@/components/AuthProvider';
import { BulkBar } from '@/components/BulkBar';
import { SavedViews } from '@/components/SavedViews';
import { ExportButton } from '@/components/ExportButton';
import { ACTIVITY_TYPE_COLOR, toggleActivity } from '@/components/RelatedActivities';
import { t, tEnum } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useOpenFromUrl, usePagedList, useSearch, useSelection } from '@/lib/hooks';
import type { Activity } from '@/lib/types';

type StatusFilter = 'all' | 'false' | 'true';
type View = 'list' | 'calendar';

/**
 * 是否逾期：未完成且截止时间早于现在。
 * Overdue: not completed and due before now.
 */
const isOverdue = (a: Activity) => !a.completed && !!a.dueAt && dayjs(a.dueAt).isBefore(dayjs());

/**
 * 关联对象标签。
 * Related-record tags.
 */
function RelatedTags({ a }: { a: Activity }) {
  return (
    <Space size={4} wrap>
      {a.account && <Tag color="geekblue">{`${t('nav.accounts')}: ${a.account.name}`}</Tag>}
      {a.lead && <Tag color="gold">{`${t('nav.leads')}: ${a.lead.name}`}</Tag>}
      {a.deal && <Tag color="green">{`${t('nav.deals')}: ${a.deal.name}`}</Tag>}
    </Space>
  );
}

export default function ActivitiesPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const search = useSearch();
  const q = search.q;
  const [type, setType] = useState<string>();
  const [status, setStatus] = useState<StatusFilter>('false');
  const { data, loading, reload, pagination } = usePagedList<Activity>('/api/activities', {
    q,
    type,
    completed: status === 'all' ? undefined : status,
    // 未完成按截止时间排序，便于处理待办 / pending items sorted by due date
    sort: status === 'false' ? 'dueAt' : 'createdAt',
  });
  const sel = useSelection(data.items, perm.can('record.update.own') || perm.canDelete);
  /** 套用视图（null 恢复列表默认筛选）/ apply a saved view (null resets the list filters) */
  const applyView = (f: Record<string, string> | null) => {
    search.set(f?.q ?? '');
    setType(f?.type);
    // 未保存完成状态的视图表示“全部”；恢复默认时为“未完成”/ a view without `completed` means all; the list default is pending
    setStatus(f ? ((f.completed as StatusFilter | undefined) ?? 'all') : 'false');
  };
  const [modal, setModal] = useState<{
    editing: Activity | null;
    dueAt?: Dayjs;
  } | null>(null);
  const [detail, setDetail] = useState<Activity | null>(null);
  const [view, setView] = useState<View>('list');
  // 通知跳转带 ?id= 时打开跟进详情 / open the activity detail for notification links with ?id=
  useOpenFromUrl(
    useCallback(
      (id: string) => {
        api<Activity>(`/api/activities/${id}`)
          .then(setDetail)
          .catch((err: Error) => message.error(err.message));
      },
      [message],
    ),
  );
  // 日历在数据变化后重新加载 / the calendar reloads after changes
  const [calendarVersion, setCalendarVersion] = useState(0);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) message.success(ok);
      void reload();
      setCalendarVersion((v) => v + 1);
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <Card
      title={t('activities.title')}
      extra={
        <Space>
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
              { value: 'list', label: t('activities.viewList') },
              { value: 'calendar', label: t('activities.viewCalendar') },
            ]}
          />
          {view === 'list' && (
            <ExportButton
              resource="activities"
              filters={{
                q,
                type,
                completed: status === 'all' ? undefined : status,
              }}
            />
          )}
          {perm.canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setModal({ editing: null })}>
              {t('activities.new')}
            </Button>
          )}
        </Space>
      }
    >
      {view === 'calendar' && <ActivityCalendar version={calendarVersion} onOpen={setDetail} onCreate={(dueAt) => setModal({ editing: null, dueAt })} />}
      {view === 'list' && (
        <>
          <Space wrap style={{ marginBottom: 16 }}>
            <Segmented<StatusFilter>
              value={status}
              onChange={setStatus}
              options={[
                { value: 'false', label: t('activities.pending') },
                { value: 'true', label: t('activities.completed') },
                { value: 'all', label: t('common.all') },
              ]}
            />
            <Select allowClear aria-label={t('activities.type')} placeholder={t('activities.type')} style={{ width: 140 }} options={activityTypeOptions} value={type} onChange={setType} />
            <SavedViews entity="activities" filters={{ q, type, completed: status === 'all' ? undefined : status }} onApply={applyView} />
            <Input.Search allowClear placeholder={t('activities.searchPlaceholder')} style={{ width: 240 }} {...search.inputProps} />
          </Space>
          <BulkBar
            path="/api/activities"
            selected={sel.selected}
            names={Object.fromEntries(data.items.map((r) => [r.id, r.subject]))}
            completable
            onDone={() => {
              sel.clear();
              void reload();
            }}
            onClear={sel.clear}
          />
          <Table<Activity>
            rowKey="id"
            rowSelection={sel.rowSelection}
            loading={loading}
            dataSource={data.items}
            pagination={{
              ...pagination,
              showTotal: (total) => t('common.total', { total }),
            }}
            columns={[
              {
                title: t('activities.completed'),
                width: 72,
                render: (_, r) => (
                  <Checkbox
                    checked={r.completed}
                    disabled={!perm.canEdit(r)}
                    aria-label={`${t('activities.markDone')} ${r.subject}`}
                    onChange={() => run(() => toggleActivity(r))}
                  />
                ),
              },
              {
                title: t('activities.type'),
                dataIndex: 'type',
                render: (v: string) => <Tag color={ACTIVITY_TYPE_COLOR[v]}>{tEnum('activityType', v)}</Tag>,
              },
              {
                title: t('activities.subject'),
                dataIndex: 'subject',
                render: (v: string, r) => (
                  <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setDetail(r)}>
                    {v}
                  </Button>
                ),
              },
              {
                title: t('activities.related'),
                render: (_, r) => <RelatedTags a={r} />,
              },
              {
                title: t('activities.dueAt'),
                dataIndex: 'dueAt',
                render: (v: string | null, r) =>
                  v && (
                    <Space size={4}>
                      <span>{fmtDateTime(v)}</span>
                      {isOverdue(r) && <Tag color="red">{t('activities.overdue')}</Tag>}
                    </Space>
                  ),
              },
              {
                title: t('common.owner'),
                render: (_, r) => r.owner?.name ?? t('common.unassigned'),
              },
              {
                title: t('common.createdAt'),
                dataIndex: 'createdAt',
                render: fmtDateTime,
              },
              {
                title: t('common.actions'),
                render: (_, r) => (
                  <Space>
                    {perm.canEdit(r) && (
                      <Button type="link" size="small" onClick={() => setModal({ editing: r })}>
                        {t('common.edit')}
                      </Button>
                    )}
                    {perm.canDelete && (
                      <Popconfirm
                        title={t('common.confirmDelete')}
                        onConfirm={() =>
                          run(
                            () =>
                              api(`/api/activities/${r.id}`, {
                                method: 'DELETE',
                              }),
                            t('common.deleted'),
                          )
                        }
                      >
                        <Button type="link" size="small" danger>
                          {t('common.delete')}
                        </Button>
                      </Popconfirm>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        </>
      )}

      <ActivityFormModal
        open={modal !== null}
        editing={modal?.editing}
        defaultDueAt={modal?.dueAt}
        extra={<ActivityRelationFields editing={modal?.editing} />}
        onClose={() => setModal(null)}
        onSaved={(saved) => {
          setModal(null);
          if (detail?.id === saved.id) setDetail(saved);
          void reload();
          setCalendarVersion((v) => v + 1);
        }}
      />

      <Drawer
        title={detail?.subject}
        size={560}
        open={detail !== null}
        onClose={() => setDetail(null)}
        extra={
          detail &&
          perm.canEdit(detail) && (
            <Space>
              <Button onClick={() => run(async () => setDetail(await toggleActivity(detail)), t('common.saved'))}>
                {detail.completed ? t('activities.markUndone') : t('activities.markDone')}
              </Button>
              <Button onClick={() => setModal({ editing: detail })}>{t('common.edit')}</Button>
            </Space>
          )
        }
      >
        {detail && (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label={t('activities.type')}>{tEnum('activityType', detail.type)}</Descriptions.Item>
            <Descriptions.Item label={t('activities.subject')}>{detail.subject}</Descriptions.Item>
            <Descriptions.Item label={t('activities.content')}>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{detail.content}</Typography.Paragraph>
            </Descriptions.Item>
            <Descriptions.Item label={t('activities.related')}>
              <RelatedTags a={detail} />
            </Descriptions.Item>
            <Descriptions.Item label={t('activities.dueAt')}>{fmtDateTime(detail.dueAt)}</Descriptions.Item>
            <Descriptions.Item label={t('activities.status')}>
              {detail.completed ? `${t('activities.completed')} · ${fmtDateTime(detail.completedAt)}` : t('activities.pending')}
            </Descriptions.Item>
            <Descriptions.Item label={t('common.owner')}>{detail.owner?.name ?? t('common.unassigned')}</Descriptions.Item>
            <Descriptions.Item label={t('common.createdAt')}>{fmtDateTime(detail.createdAt)}</Descriptions.Item>
          </Descriptions>
        )}
      </Drawer>
    </Card>
  );
}
