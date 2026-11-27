/**
 * 线索管理页：列表、搜索、筛选、新增/编辑、详情、删除。
 * Leads page: list, search, filter, create/edit, detail, delete.
 */
'use client';

import { Fragment, useCallback, useState } from 'react';
import { App, Button, Card, Descriptions, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import Link from 'next/link';
import { ApartmentOutlined, PlusOutlined, StarOutlined, SwapOutlined, UploadOutlined } from '@ant-design/icons';
import { t, tEnum, type MessageKey } from '@/i18n';
import { pickOptions } from '@/lib/picklists';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { toFormErrors, useOpenFromUrl, useOwners, usePagedList, useSearch, useSelection } from '@/lib/hooks';
import { AuditTrail } from '@/components/AuditTrail';
import { EmailLink, PhoneLink } from '@/components/PhoneLink';
import { usePermissions } from '@/components/AuthProvider';
import { AssignmentRulesModal } from '@/components/AssignmentRules';
import { BulkBar } from '@/components/BulkBar';
import { MacroRunner } from '@/components/Macros';
import { BlueprintPanel, useBlueprintStatus } from '@/components/Blueprint';
import { CadenceEnroller, CadencePanel } from '@/components/Cadences';
import { CampaignSelect } from '@/components/CampaignSelect';
import { SavedViews } from '@/components/SavedViews';
import { TagEditor, TagFilter, TagList, tagsOf } from '@/components/Tags';
import { ExportButton } from '@/components/ExportButton';
import { ImportModal } from '@/components/ImportModal';
import { ScoreDetail, ScoreFilters, ScoreTag, ScoringRulesModal, useScoring } from '@/components/Scoring';
import { NotesPanel } from '@/components/NotesPanel';
import { AttachmentsPanel } from '@/components/AttachmentsPanel';
import { ConvertLeadModal } from '@/components/ConvertLeadModal';
import { RelatedActivities } from '@/components/RelatedActivities';
import type { RecordTags, Ref } from '@/lib/types';
import { CustomFieldItems, CustomFieldValues, useCustomFields } from '@/components/CustomFields';
import { FieldGuard, visibleIn } from '@/components/FieldGuard';

/** 线索 / Lead */
interface Lead {
  /** 自定义字段的值 / custom field values */
  custom?: Record<string, unknown>;
  id: string;
  name: string;
  company: string | null;
  title: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  source: string | null;
  status: string;
  description: string | null;
  ownerId: string | null;
  owner: { id: string; name: string } | null;
  convertedAt: string | null;
  convertedAccount: Ref | null;
  convertedContact: Ref | null;
  convertedDeal: Ref | null;
  tags?: RecordTags;
  createdAt: string;
  updatedAt: string;
  /** 评分（服务端计算）/ score (computed server-side) */
  score: number;
  /** 来源市场活动 / source campaign */
  campaignId?: string | null;
  campaign?: { id: string; name: string } | null;
  /** 来源网页表单（仅详情返回）/ source web form (detail only) */
  webForm?: { id: string; name: string } | null;
}

const STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED'] as const;
const SOURCES = ['WEBSITE', 'REFERRAL', 'EXHIBITION', 'COLD_CALL', 'ADVERTISEMENT', 'SOCIAL_MEDIA', 'OTHER'] as const;
const STATUS_COLOR: Record<string, string> = { NEW: 'blue', CONTACTED: 'cyan', QUALIFIED: 'green', UNQUALIFIED: 'default', CONVERTED: 'purple' };

// 选项按组织配置（筛选含已停用的，表单只含启用的并保留当前值）/ options follow the organization's setup (filters include inactive ones; forms list active ones and keep the current value)
// “已转化”只能通过转化操作设置 / CONVERTED is only set by the conversion action
const EDITABLE_STATUSES = STATUSES.filter((s) => s !== 'CONVERTED');
/** 字段权限：字段是否显示 / field permissions: whether a field is shown */
const show = visibleIn('LEAD');
const req = (key: MessageKey) => [{ required: true, whitespace: true, message: t('common.required', { field: t(key) }) }];

export default function LeadsPage() {
  const { message } = App.useApp();
  const owners = useOwners();
  const perm = usePermissions();
  const search = useSearch();
  const q = search.q;
  const [campaignId, setCampaignId] = useState<string>();
  const [tagId, setTagId] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [source, setSource] = useState<string>();
  const [grade, setGrade] = useState<string>();
  const [sort, setSort] = useState<string>();
  const { data, loading, reload, pagination } = usePagedList<Lead>('/api/leads', { q, status, source, tagId, campaignId, grade, sort });
  const scoring = useScoring('lead');
  const [scoringOpen, setScoringOpen] = useState(false);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  /** 套用视图（null 恢复列表默认筛选）/ apply a saved view (null resets the list filters) */
  const applyView = (f: Record<string, string> | null) => {
    search.set(f?.q ?? '');
    setStatus(f?.status);
    setSource(f?.source);
    setTagId(f?.tagId);
  };
  const sel = useSelection(data.items, perm.can('record.update.own') || perm.canDelete);

  const [form] = Form.useForm();
  const customDefs = useCustomFields('LEAD');
  const [editing, setEditing] = useState<Lead | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<Lead | null>(null);
  const blueprint = useBlueprintStatus('LEAD');
  /** 宏执行后递增，使详情内的面板重新加载 / bumped after a macro run so the detail panels reload */
  const [detailVersion, setDetailVersion] = useState(0);
  /** 重新读取详情并刷新列表（宏执行后）/ reload the detail and the list (after a macro run) */
  const refreshDetail = async (id: string) => {
    try {
      setDetail(await api<Lead>(`/api/leads/${id}`));
      setDetailVersion((v) => v + 1);
    } catch {
      setDetail(null);
    }
    void reload();
  };
  const [converting, setConverting] = useState<Lead | null>(null);
  const [importing, setImporting] = useState(false);
  const editingConverted = editing !== null && editing !== 'new' && editing.convertedAt !== null;

  useOpenFromUrl(
    useCallback(
      (id: string) => {
        api<Lead>(`/api/leads/${id}`)
          .then(setDetail)
          .catch((err: Error) => message.error(err.message));
      },
      [message],
    ),
  );

  const openForm = (lead: Lead | 'new') => {
    form.resetFields();
    if (lead !== 'new') form.setFieldsValue(lead);
    setEditing(lead);
  };

  const save = async () => {
    const values = await form.validateFields();
    if (editingConverted) delete values.status;
    setSaving(true);
    try {
      const saved =
        editing === 'new'
          ? await api<Lead>('/api/leads', { method: 'POST', body: values })
          : await api<Lead>(`/api/leads/${(editing as Lead).id}`, { method: 'PATCH', body: values });
      message.success(t('common.saved'));
      setEditing(null);
      if (detail?.id === saved.id) setDetail(saved);
      void reload();
    } catch (err) {
      if (err instanceof ClientApiError) form.setFields(toFormErrors(err.details));
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (lead: Lead) => {
    try {
      await api(`/api/leads/${lead.id}`, { method: 'DELETE' });
      message.success(t('recycle.moved', { days: 30 }));
      if (detail?.id === lead.id) setDetail(null);
      void reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <Card
      title={t('leads.title')}
      extra={
        <Space>
          {perm.canCreate && (
            <Button icon={<UploadOutlined />} onClick={() => setImporting(true)}>
              {t('import.button')}
            </Button>
          )}
          <Button icon={<StarOutlined />} onClick={() => setScoringOpen(true)}>
            {t('scoring.title')}
          </Button>
          <Button icon={<ApartmentOutlined />} onClick={() => setAssignmentOpen(true)} data-testid="assignment-open">
            {t('assignment.title')}
          </Button>
          <ExportButton excel resource="leads" filters={{ q, status, source, campaignId, grade }} />
          {perm.canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm('new')}>
              {t('leads.new')}
            </Button>
          )}
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 16 }}>
        <SavedViews entity="leads" filters={{ q, status, source, tagId }} onApply={applyView} />
        <Input.Search allowClear placeholder={t('leads.searchPlaceholder')} style={{ width: 280 }} {...search.inputProps} data-testid="leads-search" />
        <TagFilter value={tagId} onChange={setTagId} onManaged={() => void reload()} />
        <Select allowClear aria-label={t('leads.status')} placeholder={t('leads.status')} style={{ width: 140 }} options={pickOptions('leadStatus', STATUSES)} value={status} onChange={setStatus} />
        <Select allowClear aria-label={t('leads.source')} placeholder={t('leads.source')} style={{ width: 140 }} options={pickOptions('leadSource', SOURCES)} value={source} onChange={setSource} />
        <ScoreFilters grade={grade} onGrade={setGrade} sort={sort} onSort={setSort} />
        <CampaignSelect aria-label={t('campaigns.filter')} placeholder={t('campaigns.filter')} style={{ width: 180 }} value={campaignId} onChange={(v) => setCampaignId(v ?? undefined)} />
      </Space>
      <BulkBar
        path="/api/leads"
        taggable
        ruleAssignable
        macroEntity="LEAD"
        cadenceEntity="LEAD"
        selected={sel.selected}
        names={Object.fromEntries(data.items.map((r) => [r.id, r.name]))}
        valueChange={{ action: 'status', field: 'status', options: pickOptions('leadStatus', EDITABLE_STATUSES, 'active') }}
        onDone={() => {
          sel.clear();
          void reload();
        }}
        onClear={sel.clear}
      />
      <Table<Lead>
        rowKey="id"
        rowSelection={sel.rowSelection}
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        columns={[
          { title: t('leads.name'), dataIndex: 'name', render: (v: string, r) => (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setDetail(r)}>
                {v}
              </Button>
            ), },
          { title: t('leads.company'), dataIndex: 'company' },
          { title: t('leads.contact'), render: (_, r) => r.mobile ?? r.phone ?? r.email },
          { title: t('leads.source'), dataIndex: 'source', render: (v: string | null) => tEnum('leadSource', v) },
          { title: t('leads.status'), dataIndex: 'status', render: (v: string) => <Tag color={STATUS_COLOR[v]}>{tEnum('leadStatus', v)}</Tag> },
          { title: t('scoring.score'), dataIndex: 'score', render: (v: number) => <ScoreTag score={v} config={scoring.config} /> },
          { title: t('tags.title'), render: (_, r) => <TagList tags={tagsOf(r)} /> },
          { title: t('common.owner'), render: (_, r) => r.owner?.name ?? t('common.unassigned') },
          { title: t('common.createdAt'), dataIndex: 'createdAt', render: fmtDateTime },
          {
            title: t('common.actions'),
            render: (_, r) => (
              <Space>
                {perm.canEdit(r) && (
                  <Button type="link" size="small" onClick={() => openForm(r)}>
                    {t('common.edit')}
                  </Button>
                )}
                {perm.canEdit(r) && perm.canCreate && (
                  <Button type="link" size="small" disabled={r.convertedAt !== null} onClick={() => setConverting(r)}>
                    {t('convert.action')}
                  </Button>
                )}
                {perm.canDelete && (
                  <Popconfirm title={t('recycle.confirmDelete')} onConfirm={() => remove(r)}>
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

      <Modal
        title={editing === 'new' ? t('leads.new') : t('leads.edit')}
        open={editing !== null}
        onOk={save}
        confirmLoading={saving}
        onCancel={() => setEditing(null)}
        okText={t('common.save')}
        width={640}
        destroyOnHidden
        forceRender
        // 从详情抽屉打开编辑时须位于抽屉之上 / must stack above the detail drawer
        zIndex={1100}
      >
        <Form form={form} name="lead" layout="vertical" initialValues={{ status: 'NEW' }}>
          <div className="form-row">
            <Form.Item name="name" label={t('leads.name')} rules={req('leads.name')}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="company" label={t('leads.company')}>
              <Input maxLength={200} />
            </Form.Item>
          </div>
          <div className="form-row">
            <FieldGuard entity="LEAD" field="title">
              <Form.Item name="title" label={t('leads.jobTitle')}>
                <Input maxLength={100} />
              </Form.Item>
            </FieldGuard>
            <FieldGuard entity="LEAD" field="email">
              <Form.Item name="email" label={t('leads.email')} rules={[{ type: 'email', message: t('common.invalidEmail') }]}>
                <Input maxLength={254} />
              </Form.Item>
            </FieldGuard>
          </div>
          <div className="form-row">
            <FieldGuard entity="LEAD" field="phone">
              <Form.Item name="phone" label={t('leads.phone')}>
                <Input maxLength={50} />
              </Form.Item>
            </FieldGuard>
            <FieldGuard entity="LEAD" field="mobile">
              <Form.Item name="mobile" label={t('leads.mobile')}>
                <Input maxLength={50} />
              </Form.Item>
            </FieldGuard>
          </div>
          <div className="form-row">
            <Form.Item name="source" label={t('leads.source')}>
              <Select allowClear options={pickOptions('leadSource', SOURCES, 'active', editing && editing !== 'new' ? editing.source : null)} />
            </Form.Item>
            <Form.Item
              name="status"
              label={t('leads.status')}
              extra={editingConverted ? t('convert.statusLocked') : blueprint && editing !== 'new' ? t('blueprints.lockedHint', { name: blueprint.name }) : undefined}
            >
              <Select options={editingConverted ? pickOptions('leadStatus', STATUSES) : pickOptions('leadStatus', EDITABLE_STATUSES, 'active', editing && editing !== 'new' ? editing.status : null)} disabled={editingConverted || (!!blueprint && editing !== 'new')} />
            </Form.Item>
            <Form.Item name="ownerId" label={t('common.owner')} extra={perm.canAssign ? undefined : t('common.ownerLocked')}>
              <Select allowClear={perm.canAssign} disabled={!perm.canAssign} options={owners.map((u) => ({ value: u.id, label: u.name }))} />
            </Form.Item>
          </div>
          <Form.Item name="campaignId" label={t('campaigns.source')}>
            <CampaignSelect key={editing && editing !== 'new' ? editing.id : 'new'} />
          </Form.Item>
          <CustomFieldItems defs={customDefs} />
          <FieldGuard entity="LEAD" field="description">
            <Form.Item name="description" label={t('common.description')}>
              <Input.TextArea rows={3} maxLength={5000} />
            </Form.Item>
          </FieldGuard>
        </Form>
      </Modal>

      <Drawer
        title={
          // 整页入口放在标题中，避免右侧按钮过多时遮挡关闭按钮 / the full-page link sits in the title so the action buttons never cover the close button
          <Space size={12}>
            {t('leads.detail')}
            {detail && (
              <Link href={`/leads/view?id=${detail.id}`} data-testid="open-full-page" style={{ fontSize: 14, fontWeight: 400 }}>
                {t('record.fullPage')}
              </Link>
            )}
          </Space>
        }
        size={640}
        open={detail !== null}
        onClose={() => setDetail(null)}
        extra={
          detail && (
            <Space>
              {!detail.convertedAt && perm.canEdit(detail) && perm.canCreate && (
                <Button type="primary" icon={<SwapOutlined />} onClick={() => setConverting(detail)}>
                  {t('convert.action')}
                </Button>
              )}
              {perm.canEdit(detail) && !detail.convertedAt && <CadenceEnroller entity="LEAD" ids={[detail.id]} names={{ [detail.id]: detail.name }} onDone={() => void refreshDetail(detail.id)} />}
              {perm.canEdit(detail) && <MacroRunner entity="LEAD" ids={[detail.id]} names={{ [detail.id]: detail.name }} onDone={() => void refreshDetail(detail.id)} />}
              {perm.canEdit(detail) && <Button onClick={() => openForm(detail)}>{t('common.edit')}</Button>}
            </Space>
          )
        }
      >
        {detail && (
          <Fragment key={detailVersion}>
            <CadencePanel entity="LEAD" id={detail.id} editable={perm.canEdit(detail)} version={detailVersion} />
            <BlueprintPanel entity="LEAD" record={detail as unknown as { id: string } & Record<string, unknown>} onDone={() => void refreshDetail(detail.id)} />
            <Descriptions column={2} bordered size="small">
              <Descriptions.Item label={t('leads.name')}>{detail.name}</Descriptions.Item>
              <Descriptions.Item label={t('leads.company')}>{detail.company}</Descriptions.Item>
              {show('title') && <Descriptions.Item label={t('leads.jobTitle')}>{detail.title}</Descriptions.Item>}
              {show('email') && (
                <Descriptions.Item label={t('leads.email')}>
                  <EmailLink value={detail.email} />
                </Descriptions.Item>
              )}
              {show('phone') && (
                <Descriptions.Item label={t('leads.phone')}>
                  <PhoneLink value={detail.phone} />
                </Descriptions.Item>
              )}
              {show('mobile') && (
                <Descriptions.Item label={t('leads.mobile')}>
                  <PhoneLink value={detail.mobile} />
                </Descriptions.Item>
              )}
              <Descriptions.Item label={t('leads.source')}>{tEnum('leadSource', detail.source)}</Descriptions.Item>
              <Descriptions.Item label={t('campaigns.source')}>
                {detail.campaign ? <Link href={`/campaigns?id=${detail.campaign.id}`}>{detail.campaign.name}</Link> : null}
              </Descriptions.Item>
              {detail.webForm && (
                <Descriptions.Item label={t('webForms.sourceForm')}>
                  <Link href={`/web-forms?id=${detail.webForm.id}`} data-testid="lead-web-form">
                    {detail.webForm.name}
                  </Link>
                </Descriptions.Item>
              )}
              <Descriptions.Item label={t('leads.status')}>{tEnum('leadStatus', detail.status)}</Descriptions.Item>
              <Descriptions.Item label={t('scoring.score')} span={2}>
                <Space orientation="vertical" size={4}>
                  <ScoreTag score={detail.score} config={scoring.config} />
                  <ScoreDetail entity="lead" id={detail.id} version={`${detail.updatedAt}:${detail.score}`} />
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('common.owner')}>{detail.owner?.name ?? t('common.unassigned')}</Descriptions.Item>
              <Descriptions.Item label={t('common.createdAt')}>{fmtDateTime(detail.createdAt)}</Descriptions.Item>
              <Descriptions.Item label={t('tags.title')} span={2}>
                <TagEditor key={`tags-${detail.id}`} path="/api/leads" record={detail} onChanged={() => void reload()} />
              </Descriptions.Item>
              {show('description') && (
                <Descriptions.Item label={t('common.description')} span={2}>
                  {detail.description}
                </Descriptions.Item>
              )}
            </Descriptions>
            <CustomFieldValues defs={customDefs} values={detail.custom} />
            {detail.convertedAt && (
              <Descriptions column={1} bordered size="small" title={t('convert.result')} style={{ marginTop: 24 }} data-testid="conversion-result">
                <Descriptions.Item label={t('convert.convertedAt')}>{fmtDateTime(detail.convertedAt)}</Descriptions.Item>
                <Descriptions.Item label={t('nav.accounts')}>
                  {detail.convertedAccount && <Link href={`/accounts?id=${detail.convertedAccount.id}`}>{detail.convertedAccount.name}</Link>}
                </Descriptions.Item>
                <Descriptions.Item label={t('convert.contact')}>{detail.convertedContact?.name}</Descriptions.Item>
                <Descriptions.Item label={t('nav.deals')}>
                  {detail.convertedDeal && <Link href={`/deals?id=${detail.convertedDeal.id}`}>{detail.convertedDeal.name}</Link>}
                </Descriptions.Item>
              </Descriptions>
            )}
            <Typography.Title level={5} style={{ marginTop: 24 }}>
              {t('notes.title')}
            </Typography.Title>
            <NotesPanel key={`notes-${detail.id}`} parent={{ leadId: detail.id }} ownerId={detail.ownerId} />
            <Typography.Title level={5} style={{ marginTop: 24 }}>
              {t('attachments.title')}
            </Typography.Title>
            <AttachmentsPanel key={`files-${detail.id}`} parent={{ leadId: detail.id }} ownerId={detail.ownerId} />
            <Typography.Title level={5} style={{ marginTop: 24 }}>
              {t('accounts.tabActivities')}
            </Typography.Title>
            <RelatedActivities key={detail.convertedAt ?? 'open'} relation={{ leadId: detail.id }} />
            <Typography.Title level={5} style={{ marginTop: 24 }}>
              {t('audit.trail')}
            </Typography.Title>
            <AuditTrail entityType="lead" entityId={detail.id} version={`${detail.updatedAt}${detail.convertedAt ?? ''}`} />
          </Fragment>
        )}
      </Drawer>
      <ConvertLeadModal
        lead={converting}
        onClose={() => setConverting(null)}
        onConverted={async () => {
          const id = converting?.id;
          setConverting(null);
          void reload();
          if (id && detail?.id === id) setDetail(await api<Lead>(`/api/leads/${id}`));
        }}
      />
      <ScoringRulesModal entity="lead" open={scoringOpen} onClose={() => setScoringOpen(false)} config={scoring.config} canManage={perm.can('scoring.manage')} onSaved={() => { scoring.reload(); void reload(); }} />
      <AssignmentRulesModal open={assignmentOpen} onClose={() => setAssignmentOpen(false)} canManage={perm.can('assignment.manage')} />
      <ImportModal resource="leads" open={importing} onClose={() => setImporting(false)} onImported={() => { setImporting(false); void reload(); }} />
    </Card>
  );
}
