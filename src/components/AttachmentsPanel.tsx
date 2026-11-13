/**
 * 附件面板（线索、客户、商机）：上传（能编辑记录时）、下载（带登录令牌获取后保存）、删除（上传人或有删除权限的角色）。
 * 前端预先检查大小与扩展名，服务端仍做最终校验（扩展名白名单 + 文件头特征）。
 * Attachments panel for leads, accounts and deals: upload (when the record is editable), download (fetched with the
 * session token, then saved) and delete (uploader or roles with delete permission). The browser pre-checks size and
 * extension; the server does the final validation (whitelist + magic bytes).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, List, Popconfirm, Space, Typography, Upload } from 'antd';
import { DownloadOutlined, PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import { t, type MessageKey } from '@/i18n';
import { api, API_BASE, ClientApiError, getToken, qs } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { usePermissions } from './AuthProvider';

/** 附件 / Attachment */
interface Attachment {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  createdAt: string;
  uploadedBy: { id: string; name: string };
}

type Parent = { leadId: string } | { accountId: string } | { dealId: string };

/** 文件大小显示 / human-readable size */
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 附件错误提示 / attachment error message */
function fileError(err: unknown): string {
  const code = err instanceof ClientApiError ? err.details?.file?.[0] : undefined;
  return code ? t(`attachments.error.${code}` as MessageKey) : (err as Error).message;
}

/**
 * 带登录令牌的原始请求（上传与下载不是 JSON）。
 * Raw request with the session token (uploads and downloads are not JSON).
 */
async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  } catch {
    throw new ClientApiError(0, 'NETWORK');
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { code: string; details?: Record<string, string[]> } } | null;
    throw new ClientApiError(res.status, data?.error?.code ?? 'INTERNAL_ERROR', data?.error?.details);
  }
  return res;
}

export function AttachmentsPanel({ parent, ownerId }: { parent: Parent; ownerId: string | null }) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const editable = perm.canEdit({ ownerId });
  const [items, setItems] = useState<Attachment[]>([]);
  const [limits, setLimits] = useState<{ maxBytes: number; extensions: string[] }>({ maxBytes: 10 * 1024 * 1024, extensions: [] });
  const [uploading, setUploading] = useState(false);
  const key = JSON.stringify(parent);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: Attachment[]; maxBytes: number; extensions: string[] }>(`/api/attachments${qs(JSON.parse(key) as Record<string, string>)}`);
      setItems(r.items);
      setLimits({ maxBytes: r.maxBytes, extensions: r.extensions });
    } catch (err) {
      message.error((err as Error).message);
    }
  }, [key, message]);

  useEffect(() => {
    // 打开时加载 / load on open
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const upload = async (file: File) => {
    const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
    if (file.size > limits.maxBytes) return void message.error(t('attachments.error.too_large'));
    if (limits.extensions.length && !limits.extensions.includes(ext)) return void message.error(t('attachments.error.type_not_allowed'));
    const form = new FormData();
    form.append('file', file);
    for (const [k, v] of Object.entries(parent)) form.append(k, v);
    setUploading(true);
    try {
      await rawFetch('/api/attachments', { method: 'POST', body: form });
      message.success(t('attachments.uploaded', { name: file.name }));
      await load();
    } catch (err) {
      message.error(fileError(err));
    } finally {
      setUploading(false);
    }
  };

  const download = async (a: Attachment) => {
    try {
      const blob = await (await rawFetch(`/api/attachments/${a.id}/download`)).blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = a.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      message.error(fileError(err));
    }
  };

  const remove = async (a: Attachment) => {
    try {
      await api(`/api/attachments/${a.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      await load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <div data-testid="attachments-panel">
      {editable && (
        <Space orientation="vertical" size={4} style={{ marginBottom: 12 }}>
          <Upload
            showUploadList={false}
            multiple
            accept={limits.extensions.map((e) => `.${e}`).join(',')}
            beforeUpload={(file) => {
              void upload(file);
              return false;
            }}
          >
            <Button icon={<UploadOutlined />} loading={uploading}>
              {t('attachments.upload')}
            </Button>
          </Upload>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('attachments.hint', { size: fmtSize(limits.maxBytes), types: limits.extensions.join(', ') })}
          </Typography.Text>
        </Space>
      )}
      <List
        size="small"
        locale={{ emptyText: t('attachments.empty') }}
        dataSource={items}
        renderItem={(a) => (
          <List.Item
            data-testid="attachment-item"
            actions={[
              <Button key="dl" type="link" size="small" icon={<DownloadOutlined />} aria-label={`${t('attachments.download')} ${a.fileName}`} onClick={() => void download(a)}>
                {t('attachments.download')}
              </Button>,
              ...((perm.canDelete || (a.uploadedBy.id === perm.meId && editable))
                ? [
                    <Popconfirm key="rm" title={t('attachments.confirmDelete', { name: a.fileName })} onConfirm={() => remove(a)}>
                      <Button type="link" size="small" danger>
                        {t('common.delete')}
                      </Button>
                    </Popconfirm>,
                  ]
                : []),
            ]}
          >
            <List.Item.Meta
              avatar={<PaperClipOutlined />}
              title={a.fileName}
              description={`${fmtSize(a.size)} · ${a.uploadedBy.name} · ${fmtDateTime(a.createdAt)}`}
            />
          </List.Item>
        )}
      />
    </div>
  );
}
