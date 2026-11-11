/**
 * CSV 导入弹窗：下载模板 → 选择文件 → 预检（逐行列出错误）→ 确认导入。
 * CSV import dialog: download template → choose a file → dry run (row errors listed) → confirm.
 */
'use client';

import { useState } from 'react';
import { Alert, App, Button, Modal, Radio, Space, Table, Typography, Upload } from 'antd';
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, apiDownload, ClientApiError } from '@/lib/api';

/** 服务端导入报告 / Server import report */
interface Report {
  dryRun: boolean;
  total: number;
  valid: number;
  created: number;
  duplicates: { row: number; value: string }[];
  errors: { row: number; field: string; reason: string }[];
  unknownColumns: string[];
}

/** 文件大小上限（与服务端一致）/ File size cap (matches the server) */
const MAX_BYTES = 1_000_000;

// 字段 → 文案 key / field → message key
const FIELD_LABELS: Record<string, MessageKey> = {
  name: 'leads.name',
  company: 'leads.company',
  title: 'leads.jobTitle',
  phone: 'leads.phone',
  mobile: 'leads.mobile',
  email: 'leads.email',
  source: 'leads.source',
  status: 'leads.status',
  ownerEmail: 'import.ownerEmail',
  description: 'common.description',
  industry: 'accounts.industry',
  website: 'accounts.website',
  address: 'accounts.address',
  'contact.name': 'import.contactName',
  'contact.title': 'import.contactTitle',
  'contact.phone': 'import.contactPhone',
  'contact.email': 'import.contactEmail',
};

/** 客户导入中与线索含义不同的字段 / account fields whose labels differ from leads */
const ACCOUNT_FIELD_LABELS: Record<string, MessageKey> = { name: 'accounts.name', phone: 'accounts.phone' };

interface Props {
  resource: 'leads' | 'accounts';
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

/**
 * 把文件级错误（服务端 details.csv）翻译为提示。
 * Translate file-level errors (server details.csv) into messages.
 */
function fileErrors(err: unknown): string[] {
  if (!(err instanceof ClientApiError)) return [(err as Error).message];
  const list = err.details?.csv;
  if (!list?.length) return [err.message];
  return list.map((code) => {
    if (code.startsWith('missing_column:')) return t('import.fileError.missing_column', { col: code.split(':')[1] ?? '' });
    return t(`import.fileError.${code}` as MessageKey);
  });
}

export function ImportModal({ resource, open, onClose, onImported }: Props) {
  const { message } = App.useApp();
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [duplicates, setDuplicates] = useState<'skip' | 'create'>('skip');
  const [report, setReport] = useState<Report | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setCsv(null);
    setFileName('');
    setReport(null);
    setProblems([]);
  };

  const send = async (dryRun: boolean) => {
    if (!csv) return;
    setBusy(true);
    setProblems([]);
    try {
      const r = await api<Report>(`/api/${resource}/import`, { method: 'POST', body: { csv, dryRun, duplicates } });
      if (dryRun) setReport(r);
      else {
        message.success(t('import.done', { n: r.created }));
        reset();
        onImported();
      }
    } catch (err) {
      setReport(null);
      setProblems(fileErrors(err));
    } finally {
      setBusy(false);
    }
  };

  const title = resource === 'leads' ? t('import.titleLeads') : t('import.titleAccounts');

  return (
    <Modal
      title={title}
      open={open}
      onCancel={() => {
        reset();
        onClose();
      }}
      width={720}
      footer={[
        <Button key="check" onClick={() => send(true)} disabled={!csv} loading={busy && !report}>
          {t('import.check')}
        </Button>,
        <Button key="go" type="primary" disabled={!report || report.valid === 0} loading={busy && !!report} onClick={() => send(false)}>
          {report && report.valid > 0 ? t('import.confirm', { n: report.valid }) : t('import.nothing')}
        </Button>,
      ]}
    >
      <Space orientation="vertical" size={16} style={{ width: '100%' }} data-testid="import-modal">
        <div>
          <Typography.Paragraph style={{ marginBottom: 8 }}>{t('import.step1')}</Typography.Paragraph>
          <Button
            icon={<DownloadOutlined />}
            onClick={() => apiDownload(`/api/${resource}/import/template`, `${resource}-import-template.csv`).catch((e: Error) => message.error(e.message))}
          >
            {t('import.template')}
          </Button>
        </div>
        <div>
          <Typography.Paragraph style={{ marginBottom: 8 }}>{t('import.step2')}</Typography.Paragraph>
          <Upload
            accept=".csv,text/csv"
            maxCount={1}
            showUploadList={false}
            beforeUpload={async (file) => {
              if (file.size > MAX_BYTES) {
                message.error(t('import.tooLarge'));
                return Upload.LIST_IGNORE;
              }
              setCsv(await file.text());
              setFileName(file.name);
              setReport(null);
              setProblems([]);
              return false;
            }}
          >
            <Button icon={<UploadOutlined />}>{t('import.choose')}</Button>
          </Upload>
          {fileName && (
            <Typography.Text style={{ marginLeft: 12 }} data-testid="import-file">
              {fileName}
            </Typography.Text>
          )}
        </div>
        <div>
          <Typography.Text>{resource === 'leads' ? t('import.duplicatesLeads') : t('import.duplicatesAccounts')}：</Typography.Text>
          <Radio.Group
            value={duplicates}
            onChange={(e) => {
              setDuplicates(e.target.value);
              setReport(null);
            }}
            options={[
              { value: 'skip', label: t('import.skip') },
              { value: 'create', label: t('import.create') },
            ]}
          />
        </div>
        {problems.length > 0 && <Alert type="error" showIcon title={problems.join('；')} />}
        {report && (
          <div data-testid="import-report">
            <Alert
              type={report.errors.length ? 'warning' : 'success'}
              showIcon
              title={t('import.summary', { total: report.total, valid: report.valid, dup: report.duplicates.length, err: report.errors.length })}
              description={report.unknownColumns.length ? t('import.unknownColumns', { cols: report.unknownColumns.join('、') }) : undefined}
            />
            {report.errors.length > 0 && (
              <Table
                size="small"
                style={{ marginTop: 12 }}
                rowKey={(r) => `${r.row}-${r.field}-${r.reason}`}
                pagination={{ pageSize: 8, hideOnSinglePage: true }}
                dataSource={report.errors}
                columns={[
                  { title: t('import.row'), dataIndex: 'row', width: 80 },
                  {
                    title: t('import.field'),
                    dataIndex: 'field',
                    render: (f: string) => {
                      const key = (resource === 'accounts' ? ACCOUNT_FIELD_LABELS[f] : undefined) ?? FIELD_LABELS[f];
                      return key ? t(key) : f;
                    },
                  },
                  { title: t('import.reason'), dataIndex: 'reason', render: (r: string) => tEnum('importReason', r) },
                ]}
              />
            )}
          </div>
        )}
      </Space>
    </Modal>
  );
}
