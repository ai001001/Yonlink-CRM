/**
 * 公开网页表单页（无需登录）：/web-form?key=…，可直接分享链接或用 iframe 嵌入网站。
 * 按表单配置显示字段，提交后显示成功提示；含对访客隐藏的诱饵字段。
 * Public web form page (no sign-in): /web-form?key=…, shared as a link or embedded with an iframe. Fields follow the
 * form settings; a success message is shown after submitting; includes a honeypot field hidden from visitors.
 */
'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, Result, Spin, Typography } from 'antd';
import { LanguageSwitch } from '@/components/LanguageSwitch';
import { t, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';

/** 公开表单配置 / public form settings */
interface PublicForm {
  title: string;
  intro: string | null;
  fields: { name: string; required: boolean }[];
  successMessage: string | null;
}

/** 字段输入控件的最大长度 / max lengths of the inputs */
const MAX: Record<string, number> = { company: 200, title: 100, email: 254, phone: 50, mobile: 50, description: 2000 };

export default function WebFormPage() {
  const [form] = Form.useForm<Record<string, string>>();
  const [key, setKey] = useState<string | null>(null);
  const [config, setConfig] = useState<PublicForm | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'done'>('loading');
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const k = new URLSearchParams(window.location.search).get('key') ?? '';
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKey(k);
    api<PublicForm>(`/api/public/web-forms/${encodeURIComponent(k)}`)
      .then((r) => {
        setConfig(r);
        setState('ready');
      })
      .catch(() => setState('missing'));
  }, []);

  const submit = async () => {
    const values = await form.validateFields();
    setSending(true);
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== ''));
      const r = await api<{ successMessage: string | null }>(`/api/public/web-forms/${encodeURIComponent(key ?? '')}`, { method: 'POST', body });
      setSuccess(r.successMessage);
      setState('done');
    } catch (err) {
      if (err instanceof ClientApiError && err.status === 429) setError(t('webForms.public.tooMany'));
      else if (err instanceof ClientApiError && err.status === 404) setState('missing');
      else if (err instanceof ClientApiError && err.details) {
        form.setFields(Object.entries(err.details).map(([name, codes]) => ({ name, errors: [t(`webForms.public.error.${codes[0]?.split(':')[0]}` as MessageKey)] })));
      } else setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', background: 'var(--ant-color-bg-layout, #f5f5f5)', padding: '24px 16px' }}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <LanguageSwitch />
        </div>
        <Card data-testid="public-web-form">
          {state === 'loading' && (
            <div style={{ textAlign: 'center', padding: 32 }}>
              <Spin />
            </div>
          )}
          {state === 'missing' && <Result status="404" title={t('webForms.public.missing')} subTitle={t('webForms.public.missingHint')} />}
          {state === 'done' && <Result status="success" title={success ?? t('webForms.public.thanks')} data-testid="web-form-success" />}
          {state === 'ready' && config && (
            <>
              <Typography.Title level={3}>{config.title}</Typography.Title>
              {config.intro && <Typography.Paragraph type="secondary" style={{ whiteSpace: 'pre-wrap' }}>{config.intro}</Typography.Paragraph>}
              {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
              <Form form={form} name="web-form" layout="vertical" onFinish={submit}>
                <Form.Item name="name" label={t('webForms.field.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('webForms.field.name') }) }]}>
                  <Input maxLength={100} autoComplete="name" />
                </Form.Item>
                {config.fields.map((f) => {
                  const label = t(`webForms.field.${f.name}` as MessageKey);
                  const rules = [
                    ...(f.required ? [{ required: true, whitespace: true, message: t('common.required', { field: label }) }] : []),
                    ...(f.name === 'email' ? [{ type: 'email' as const, message: t('webForms.public.error.email') }] : []),
                  ];
                  return (
                    <Form.Item key={f.name} name={f.name} label={label} rules={rules}>
                      {f.name === 'description' ? <Input.TextArea rows={4} maxLength={MAX.description} /> : <Input maxLength={MAX[f.name]} type={f.name === 'email' ? 'email' : 'text'} />}
                    </Form.Item>
                  );
                })}
                {/* 诱饵字段：对访客与读屏软件隐藏，机器人常会填写 / honeypot: hidden from visitors and screen readers */}
                <div aria-hidden="true" style={{ position: 'absolute', left: -10000, width: 1, height: 1, overflow: 'hidden' }}>
                  <Form.Item name="website" label="Website">
                    <Input tabIndex={-1} autoComplete="off" />
                  </Form.Item>
                </div>
                <Button type="primary" htmlType="submit" loading={sending} block>
                  {t('webForms.public.submit')}
                </Button>
              </Form>
            </>
          )}
        </Card>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center', marginTop: 12, fontSize: 12 }}>
          {t('webForms.public.privacy')}
        </Typography.Paragraph>
      </div>
    </main>
  );
}
