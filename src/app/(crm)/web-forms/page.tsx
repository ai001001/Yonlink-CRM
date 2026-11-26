/**
 * 网页表单页（对标 Zoho Webforms）：列表、详情（表单地址、嵌入代码、最近生成的线索）、新建、编辑、重新生成地址、删除。
 * 所有用户可查看；维护需 campaign.manage（管理员、经理）。
 * Web forms page (cf. Zoho Webforms): list, details (form URL, embed code, recent leads), create, edit, regenerate the
 * URL and delete. Everyone can view; changes need campaign.manage (admins, managers).
 */
'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { App, Button, Card, Checkbox, Descriptions, Drawer, Form, Input, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { CopyOutlined, ExportOutlined, PlusOutlined } from '@ant-design/icons';
import { usePermissions } from '@/components/AuthProvider';
import { CampaignSelect } from '@/components/CampaignSelect';
import { t, tEnum, type MessageKey } from '@/i18n';
import { pickOptions, pickValues } from '@/lib/picklists';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useOpenFromUrl, useOwners, usePagedList, useSearch } from '@/lib/hooks';

/** 可选字段 / optional fields */
const FIELDS = ['company', 'title', 'email', 'phone', 'mobile', 'description'] as const;
const SOURCES = ['WEBSITE', 'REFERRAL', 'EXHIBITION', 'COLD_CALL', 'ADVERTISEMENT', 'SOCIAL_MEDIA', 'OTHER'];

/** 网页表单 / Web form */
interface WebForm {
  id: string;
  name: string;
  publicKey: string;
  isActive: boolean;
  title: string;
  intro: string | null;
  fields: string[];
  requiredFields: string[];
  source: string;
  ownerId: string | null;
  assignByRule: boolean;
  campaignId: string | null;
  successMessage: string | null;
  submissionCount: number;
  lastSubmittedAt: string | null;
  createdAt: string;
  owner: { id: string; name: string } | null;
  campaign: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
  leads?: { id: string; name: string; company: string | null; status: string; createdAt: string }[];
}

type FormValues = Pick<WebForm, 'name' | 'title' | 'intro' | 'isActive' | 'fields' | 'requiredFields' | 'source' | 'ownerId' | 'assignByRule' | 'campaignId' | 'successMessage'>;

/**
 * 表单的公开地址（本站 /web-form 页面）。部署路径前缀与末尾斜杠沿用当前地址（GitHub Pages 为 /Yonlink-CRM/…/），
 * 避免依赖跳转。
 * The form's public URL (this site's /web-form page). The base path and trailing-slash style follow the current URL
 * (GitHub Pages uses /Yonlink-CRM/…/) so no redirect is needed.
 */
function publicUrl(key: string): string {
  const { origin, pathname } = window.location;
  const base = pathname.replace(/\/web-forms\/?$/, '');
  const slash = pathname.endsWith('/') ? '/' : '';
  return `${origin}${base}/web-form${slash}?key=${encodeURIComponent(key)}`;
}

/** 嵌入代码 / embed snippet */
function embedCode(key: string): string {
  return `<iframe src="${publicUrl(key)}" width="100%" height="720" style="border:0" title="web form"></iframe>`;
}

export default function WebFormsPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canManage = perm.can('campaign.manage');
  const owners = useOwners();
  const search = useSearch();
  const [active, setActive] = useState<string>('true');
  const { data, loading, reload, pagination } = usePagedList<WebForm>('/api/web-forms', { q: search.q || undefined, active: active === 'all' ? undefined : active });
  const [detail, setDetail] = useState<WebForm | null>(null);
  const [editing, setEditing] = useState<WebForm | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<FormValues>();
  const enabled = Form.useWatch('fields', form) ?? [];
  const byRule = Form.useWatch('assignByRule', form) ?? false;

  const openDetail = useCallback(
    (id: string) => {
      api<WebForm>(`/api/web-forms/${id}`)
        .then(setDetail)
        .catch((err: Error) => message.error(err.message));
    },
    [message],
  );
  useOpenFromUrl(openDetail);

  const openForm = (f: WebForm | 'new') => {
    form.resetFields();
    form.setFieldsValue(
      f === 'new'
        ? { isActive: true, fields: ['company', 'email', 'phone', 'description'], requiredFields: ['email'], source: pickValues('leadSource', SOURCES, 'active')[0] ?? 'WEBSITE', ownerId: null, assignByRule: false, campaignId: null }
        : { name: f.name, title: f.title, intro: f.intro, isActive: f.isActive, fields: f.fields, requiredFields: f.requiredFields, source: f.source, ownerId: f.ownerId, assignByRule: f.assignByRule, campaignId: f.campaignId, successMessage: f.successMessage },
    );
    setEditing(f);
  };

  const save = async () => {
    const v = await form.validateFields();
    // 未启用的字段不能必填 / only enabled fields can be required
    const body = { ...v, intro: v.intro ?? null, successMessage: v.successMessage ?? null, ownerId: v.assignByRule ? null : (v.ownerId ?? null), assignByRule: !!v.assignByRule, campaignId: v.campaignId ?? null, requiredFields: (v.requiredFields ?? []).filter((f) => v.fields.includes(f)) };
    setSaving(true);
    try {
      const saved = editing === 'new' ? await api<WebForm>('/api/web-forms', { method: 'POST', body }) : await api<WebForm>(`/api/web-forms/${(editing as WebForm).id}`, { method: 'PATCH', body });
      message.success(t('common.saved'));
      setEditing(null);
      void reload();
      if (editing === 'new' || detail?.id === saved.id) openDetail(saved.id);
    } catch (err) {
      if (err instanceof ClientApiError && err.details?.name?.[0] === 'taken') form.setFields([{ name: 'name', errors: [t('webForms.error.taken')] }]);
      else message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (f: WebForm) => {
    try {
      await api(`/api/web-forms/${f.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      if (detail?.id === f.id) setDetail(null);
      void reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const regenerate = async (f: WebForm) => {
    try {
      await api(`/api/web-forms/${f.id}/regenerate-key`, { method: 'POST' });
      message.success(t('webForms.regenerated'));
      openDetail(f.id);
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(t('webForms.copied'));
    } catch {
      message.error(t('webForms.copyFailed'));
    }
  };

  const fieldTags = (f: WebForm) => (
    <Space wrap size={4}>
      <Tag color="blue">{t('webForms.field.name')}*</Tag>
      {f.fields.map((x) => (
        <Tag key={x} color={f.requiredFields.includes(x) ? 'blue' : 'default'}>
          {t(`webForms.field.${x}` as MessageKey)}
          {f.requiredFields.includes(x) ? '*' : ''}
        </Tag>
      ))}
    </Space>
  );

  return (
    <Card
      title={t('webForms.title')}
      extra={
        canManage && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm('new')}>
            {t('webForms.new')}
          </Button>
        )
      }
    >
      <Typography.Paragraph type="secondary">{t('webForms.intro.page')}</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented
          value={active}
          onChange={(v) => setActive(String(v))}
          options={[
            { value: 'true', label: t('webForms.active') },
            { value: 'false', label: t('webForms.inactive') },
            { value: 'all', label: t('common.all') },
          ]}
        />
        <Input.Search allowClear placeholder={t('webForms.searchPlaceholder')} style={{ width: 280 }} {...search.inputProps} />
      </Space>
      <Table<WebForm>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('webForms.name'),
            render: (_, r) => (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openDetail(r.id)}>
                {r.name}
              </Button>
            ),
          },
          { title: t('leads.source'), render: (_, r) => tEnum('leadSource', r.source) },
          { title: t('common.owner'), render: (_, r) => (r.assignByRule ? t('webForms.byRule') : (r.owner?.name ?? t('common.unassigned'))) },
          { title: t('campaigns.source'), render: (_, r) => r.campaign?.name },
          { title: t('webForms.submissions'), align: 'right', dataIndex: 'submissionCount' },
          { title: t('webForms.lastSubmitted'), render: (_, r) => (r.lastSubmittedAt ? fmtDateTime(r.lastSubmittedAt) : '') },
          { title: t('webForms.status'), render: (_, r) => (r.isActive ? <Tag color="green">{t('webForms.active')}</Tag> : <Tag>{t('webForms.inactive')}</Tag>) },
        ]}
      />

      <Drawer
        title={detail ? `${t('webForms.detail')} · ${detail.name}` : t('webForms.detail')}
        size={760}
        open={detail !== null}
        onClose={() => setDetail(null)}
        extra={
          detail &&
          canManage && (
            <Space>
              <Button onClick={() => openForm(detail)}>{t('common.edit')}</Button>
              <Popconfirm title={t('webForms.confirmDelete')} onConfirm={() => remove(detail)}>
                <Button danger>{t('common.delete')}</Button>
              </Popconfirm>
            </Space>
          )
        }
      >
        {detail && (
          <div data-testid="webform-detail">
            {!detail.isActive && <Typography.Paragraph type="warning">{t('webForms.inactiveHint')}</Typography.Paragraph>}
            <Typography.Title level={5}>{t('webForms.url')}</Typography.Title>
            <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
              <Input readOnly value={publicUrl(detail.publicKey)} aria-label={t('webForms.url')} data-testid="webform-url" />
              <Button icon={<CopyOutlined />} onClick={() => copy(publicUrl(detail.publicKey))}>
                {t('webForms.copy')}
              </Button>
              <Button icon={<ExportOutlined />} href={publicUrl(detail.publicKey)} target="_blank" rel="noopener noreferrer">
                {t('webForms.open')}
              </Button>
            </Space.Compact>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>
              {t('webForms.embedHint')}
            </Typography.Paragraph>
            <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
              <Input.TextArea readOnly autoSize value={embedCode(detail.publicKey)} aria-label={t('webForms.embed')} />
              <Button icon={<CopyOutlined />} onClick={() => copy(embedCode(detail.publicKey))}>
                {t('webForms.copy')}
              </Button>
            </Space.Compact>
            {canManage && (
              <Popconfirm title={t('webForms.confirmRegenerate')} onConfirm={() => regenerate(detail)}>
                <Button size="small" style={{ marginBottom: 16 }}>
                  {t('webForms.regenerate')}
                </Button>
              </Popconfirm>
            )}

            <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label={t('webForms.formTitle')} span={2}>
                {detail.title}
              </Descriptions.Item>
              <Descriptions.Item label={t('webForms.fields')} span={2}>
                {fieldTags(detail)}
              </Descriptions.Item>
              <Descriptions.Item label={t('leads.source')}>{tEnum('leadSource', detail.source)}</Descriptions.Item>
              <Descriptions.Item label={t('common.owner')}>{detail.assignByRule ? t('webForms.byRule') : (detail.owner?.name ?? t('common.unassigned'))}</Descriptions.Item>
              <Descriptions.Item label={t('campaigns.source')}>{detail.campaign?.name}</Descriptions.Item>
              <Descriptions.Item label={t('webForms.status')}>{detail.isActive ? t('webForms.active') : t('webForms.inactive')}</Descriptions.Item>
              <Descriptions.Item label={t('webForms.submissions')}>{detail.submissionCount}</Descriptions.Item>
              <Descriptions.Item label={t('webForms.lastSubmitted')}>{detail.lastSubmittedAt ? fmtDateTime(detail.lastSubmittedAt) : ''}</Descriptions.Item>
              <Descriptions.Item label={t('webForms.successMessage')} span={2}>
                {detail.successMessage ?? t('webForms.public.thanks')}
              </Descriptions.Item>
            </Descriptions>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              title={() => t('webForms.recentLeads')}
              data-testid="webform-leads"
              dataSource={detail.leads ?? []}
              locale={{ emptyText: t('webForms.noLeads') }}
              columns={[
                { title: t('leads.name'), render: (_, r) => <Link href={`/leads?id=${r.id}`}>{r.name}</Link> },
                { title: t('leads.company'), dataIndex: 'company' },
                { title: t('leads.status'), render: (_, r) => tEnum('leadStatus', r.status) },
                { title: t('common.createdAt'), render: (_, r) => fmtDateTime(r.createdAt) },
              ]}
            />
          </div>
        )}
      </Drawer>

      <Modal title={editing === 'new' ? t('webForms.new') : t('webForms.edit')} open={editing !== null} onOk={save} confirmLoading={saving} onCancel={() => setEditing(null)} okText={t('common.save')} width={720} forceRender zIndex={1100}>
        <Form form={form} name="webform" layout="vertical">
          <div className="form-row">
            <Form.Item name="name" label={t('webForms.name')} extra={t('webForms.nameHint')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('webForms.name') }) }]}>
              <Input maxLength={200} />
            </Form.Item>
            <Form.Item name="isActive" label={t('webForms.status')} valuePropName="checked">
              <Switch checkedChildren={t('webForms.active')} unCheckedChildren={t('webForms.inactive')} />
            </Form.Item>
          </div>
          <Form.Item name="title" label={t('webForms.formTitle')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('webForms.formTitle') }) }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="intro" label={t('webForms.intro')}>
            <Input.TextArea rows={2} maxLength={1000} />
          </Form.Item>
          <Form.Item name="fields" label={t('webForms.fields')} extra={t('webForms.fieldsHint')}>
            <Checkbox.Group options={FIELDS.map((f) => ({ value: f, label: t(`webForms.field.${f}` as MessageKey) }))} />
          </Form.Item>
          <Form.Item name="requiredFields" label={t('webForms.requiredFields')}>
            <Checkbox.Group options={FIELDS.map((f) => ({ value: f, label: t(`webForms.field.${f}` as MessageKey), disabled: !enabled.includes(f) }))} />
          </Form.Item>
          <div className="form-row">
            <Form.Item name="source" label={t('leads.source')}>
              <Select options={pickOptions('leadSource', SOURCES, 'active', editing && editing !== 'new' ? editing.source : null)} />
            </Form.Item>
            <Form.Item name="ownerId" label={t('webForms.owner')} extra={t(byRule ? 'webForms.ownerRuleHint' : 'webForms.ownerHint')}>
              <Select
                allowClear
                disabled={byRule}
                placeholder={t(byRule ? 'webForms.byRule' : 'common.unassigned')}
                options={owners.map((u) => ({ value: u.id, label: u.name }))}
              />
            </Form.Item>
            <Form.Item name="assignByRule" label={t('webForms.assignByRule')} valuePropName="checked">
              <Switch aria-label={t('webForms.assignByRule')} onChange={(on) => on && form.setFieldValue('ownerId', null)} />
            </Form.Item>
            <Form.Item name="campaignId" label={t('campaigns.source')}>
              <CampaignSelect />
            </Form.Item>
          </div>
          <Form.Item name="successMessage" label={t('webForms.successMessage')}>
            <Input maxLength={500} placeholder={t('webForms.public.thanks')} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
