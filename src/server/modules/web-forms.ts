/**
 * 网页表单（对标 Zoho Webforms）：生成公开表单页，访客提交后自动创建线索。
 * - 所有用户可查看表单；新建、修改、删除、重新生成地址需 campaign.manage（管理员、经理，属于营销设置）。
 * - 姓名始终显示且必填；可选字段（公司、职位、邮箱、电话、手机、留言）可启用并设为必填。
 * - 公开提交（无需登录）：只接受已启用的字段；隐藏的诱饵字段被填写时假装成功但不保存；按来源 IP 与表单限流；
 *   请求体不超过 16 KB。生成的线索使用表单配置的来源、负责人（已停用则不分配）、市场活动，状态为新线索，
 *   并通知负责人、写审计（操作人为空，注明来源表单）、更新表单的提交次数与最近提交时间。
 * - 公开标识（publicKey）可重新生成，旧地址立即失效；停用的表单不能查看或提交（404）。
 * Web forms (cf. Zoho Webforms): public pages whose submissions become leads. Everyone can read forms; create, update,
 * delete and key regeneration need campaign.manage (admins, managers; marketing settings). Name is always shown and
 * required; optional fields (company, title, email, phone, mobile, message) can be enabled and required. Public
 * submissions (no sign-in) accept enabled fields only; a filled honeypot pretends success but stores nothing;
 * submissions are rate-limited per IP and per form; bodies are capped at 16 KB. Leads take the form's source, owner
 * (unassigned when inactive) and campaign with status NEW; the owner is notified, the creation is audited without an
 * actor and with the form name, and the form's counters are updated. The public key can be regenerated, invalidating
 * the old URL at once; inactive forms cannot be viewed or submitted (404).
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { NotificationType } from '@/generated/prisma/enums';
import { audit, by, diff, snapshot, type RequestMeta } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { requirePermission, visible } from '../permissions';
import { containsText, listQuery, optionalEmail, optionalText, requiredText, resolveOwner, type Page } from '../validation';
import { assertCampaign } from './campaign-links';
import { LEAD_SOURCES } from './leads';

/** 可选字段（顺序即表单显示顺序）/ optional fields, in display order */
export const WEB_FORM_FIELDS = ['company', 'title', 'email', 'phone', 'mobile', 'description'] as const;
export type WebFormField = (typeof WEB_FORM_FIELDS)[number];

/** 诱饵字段名（对访客隐藏）/ honeypot field name (hidden from visitors) */
export const HONEYPOT = 'website';

const fieldList = z
  .array(z.enum(WEB_FORM_FIELDS))
  .max(WEB_FORM_FIELDS.length)
  .transform((v) => WEB_FORM_FIELDS.filter((f) => v.includes(f)));

const settings = {
  name: requiredText(200),
  title: requiredText(200),
  intro: optionalText(1000),
  isActive: z.boolean().default(true),
  fields: fieldList.default(['company', 'email', 'phone', 'description']),
  requiredFields: fieldList.default([]),
  source: z.enum(LEAD_SOURCES).default('WEBSITE'),
  ownerId: z.uuid().nullish().transform((v) => v ?? null),
  campaignId: z.uuid().nullish().transform((v) => v ?? null),
  successMessage: optionalText(500),
};

/** 新建表单 / Create a form */
export const webFormCreateSchema = z.strictObject(settings);
/** 修改表单 / Update a form */
export const webFormUpdateSchema = z
  .strictObject({
    ...settings,
    isActive: z.boolean(),
    fields: fieldList,
    requiredFields: fieldList,
    source: z.enum(LEAD_SOURCES),
    ownerId: z.uuid().nullable(),
    campaignId: z.uuid().nullable(),
  })
  .partial();
/** 列表查询 / List query */
export const webFormListSchema = listQuery.extend({ active: z.enum(['true', 'false']).optional() });

const include = {
  owner: { select: { id: true, name: true } },
  campaign: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.WebFormInclude;

/** 生成公开标识（32 字节随机数，43 个字符）/ a public key: 32 random bytes, 43 characters */
function newKey(): string {
  return randomBytes(32).toString('base64url');
}

/** 名称重复 / duplicate name */
function nameTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Web form name already exists', { name: ['taken'] });
  throw err;
}

/** 必填字段必须已启用 / required fields must be enabled */
function checkFields(fields: readonly string[], required: readonly string[]): void {
  const missing = required.filter((f) => !fields.includes(f));
  if (missing.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Required fields must be enabled', { requiredFields: missing.map((f) => `not_enabled:${f}`) });
}

/**
 * 负责人须为本组织启用的用户；市场活动须属于本组织。
 * The owner must be an active user of the organization; the campaign must belong to it.
 */
async function checkRefs(ctx: AuthContext, ownerId: string | null | undefined, campaignId: string | null | undefined): Promise<void> {
  if (ownerId) await resolveOwner(ctx.organizationId, ownerId, null);
  await assertCampaign(ctx.organizationId, campaignId);
}

/**
 * 分页搜索表单（名称、标题）。
 * Search forms (name, title), paginated.
 */
export async function listWebForms(ctx: AuthContext, query: z.infer<typeof webFormListSchema>): Promise<Page<unknown>> {
  const where: Prisma.WebFormWhereInput = { organizationId: ctx.organizationId, isActive: query.active === undefined ? undefined : query.active === 'true' };
  if (query.q) {
    const c = containsText(query.q);
    where.OR = [{ name: c }, { title: c }];
  }
  const [items, total] = await prisma.$transaction([
    prisma.webForm.findMany({ where, include, orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.webForm.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 表单详情，附最近 10 条由该表单生成且当前用户可见的线索。
 * Form detail with the 10 latest leads it created that the user can see.
 */
export async function getWebForm(ctx: AuthContext, id: string) {
  const form = await prisma.webForm.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: {
      ...include,
      leads: { where: visible(ctx), select: { id: true, name: true, company: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 10 },
    },
  });
  if (!form) throw notFound();
  return form;
}

/**
 * 新建表单（自动生成公开标识）。
 * Create a form (with a fresh public key).
 */
export async function createWebForm(ctx: AuthContext, input: z.infer<typeof webFormCreateSchema>) {
  requirePermission(ctx, 'campaign.manage');
  checkFields(input.fields, input.requiredFields);
  await checkRefs(ctx, input.ownerId, input.campaignId);
  try {
    return await prisma.$transaction(async (tx) => {
      const form = await tx.webForm.create({ data: { ...input, organizationId: ctx.organizationId, publicKey: newKey(), createdById: ctx.userId }, include });
      await audit(tx, { ...by(ctx), action: 'webform.create', entityType: 'webform', entityId: form.id, changes: { after: snapshot('webform', form) } });
      return form;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 读取表单（用于维护）。
 * Load a form for maintenance.
 */
async function requireForm(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'campaign.manage');
  const form = await prisma.webForm.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!form) throw notFound();
  return form;
}

/**
 * 修改表单。
 * Update a form.
 */
export async function updateWebForm(ctx: AuthContext, id: string, input: z.infer<typeof webFormUpdateSchema>) {
  const current = await requireForm(ctx, id);
  checkFields(input.fields ?? current.fields, input.requiredFields ?? current.requiredFields);
  await checkRefs(ctx, input.ownerId, input.campaignId);
  try {
    return await prisma.$transaction(async (tx) => {
      const form = await tx.webForm.update({ where: { id }, data: input, include });
      const fields = diff('webform', current, form);
      if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'webform.update', entityType: 'webform', entityId: id, changes: { fields } });
      return form;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 重新生成公开标识：旧地址立即失效（用于地址泄露或垃圾提交）。
 * Regenerate the public key; the old URL stops working at once (for leaked URLs or spam).
 */
export async function regenerateKey(ctx: AuthContext, id: string) {
  await requireForm(ctx, id);
  return prisma.$transaction(async (tx) => {
    const form = await tx.webForm.update({ where: { id }, data: { publicKey: newKey() }, include });
    await audit(tx, { ...by(ctx), action: 'webform.regenerate_key', entityType: 'webform', entityId: id });
    return form;
  });
}

/**
 * 删除表单：已生成的线索保留，来源表单置空。
 * Delete a form; the leads it created stay, with the source form cleared.
 */
export async function deleteWebForm(ctx: AuthContext, id: string): Promise<void> {
  const current = await requireForm(ctx, id);
  await prisma.$transaction(async (tx) => {
    await tx.webForm.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'webform.delete', entityType: 'webform', entityId: id, changes: { before: { ...snapshot('webform', current), submissionCount: current.submissionCount } } });
  });
}

// ---------------------------------------------------------------------------
// 公开接口 / public endpoints

/** 公开标识格式 / public key format */
const publicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);

/**
 * 按公开标识读取启用的表单；不存在、已停用、格式不对一律 404（不区分原因）。
 * Load an active form by its public key; unknown, inactive and malformed keys are all 404.
 */
async function activeForm(key: string) {
  if (!publicKeySchema.safeParse(key).success) throw notFound();
  const form = await prisma.webForm.findUnique({ where: { publicKey: key } });
  if (!form || !form.isActive) throw notFound();
  return form;
}

/**
 * 公开表单配置（只返回显示所需的信息，不含组织、负责人等内部数据）。
 * Public form settings: only what the page needs, nothing internal (organization, owner …).
 */
export async function publicWebForm(key: string) {
  const form = await activeForm(key);
  return {
    title: form.title,
    intro: form.intro,
    fields: form.fields.map((name) => ({ name, required: form.requiredFields.includes(name) })),
    successMessage: form.successMessage,
  };
}

/** 访客可提交的字段；未启用的字段由服务端拒绝 / visitor fields; disabled ones are rejected server-side */
export const submissionSchema = z.strictObject({
  name: requiredText(100),
  company: optionalText(200),
  title: optionalText(100),
  email: optionalEmail,
  phone: optionalText(50),
  mobile: optionalText(50),
  description: optionalText(2000),
  [HONEYPOT]: z.string().max(200).optional(),
});

/** 每个来源 IP 每个表单 10 分钟内最多 5 次；每个表单 1 小时内最多 200 次 / 5 per IP per form per 10 min; 200 per form per hour */
const IP_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 };
const FORM_LIMIT = { max: 200, windowMs: 60 * 60 * 1000 };
const hits = new Map<string, { count: number; resetAt: number }>();

/**
 * 计数并判断是否超限（进程内计数；多实例部署时每个实例单独计数）。
 * Count a hit and report whether the limit is exceeded (in-process; each instance counts separately).
 */
function limited(key: string, limit: { max: number; windowMs: number }, now: number): boolean {
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + limit.windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > limit.max;
}

/**
 * 清空提交限流状态（仅供测试）。
 * Reset the submission limiter (tests only).
 */
export function resetWebFormLimiter(): void {
  hits.clear();
}

/**
 * 公开提交：校验并创建线索。
 * Public submission: validate and create a lead.
 * @returns 成功提示（诱饵字段被填写时同样返回成功，但不保存）/ the success message (also returned, without saving, for honeypot hits)
 */
export async function submitWebForm(key: string, input: z.infer<typeof submissionSchema>, meta: RequestMeta) {
  const form = await activeForm(key);
  const now = Date.now();
  const ip = meta.ip ?? 'unknown';
  if (limited(`ip:${form.id}:${ip}`, IP_LIMIT, now) || limited(`form:${form.id}`, FORM_LIMIT, now)) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many submissions, please try again later');
  }
  const done = { ok: true as const, successMessage: form.successMessage };
  // 诱饵字段：真实访客看不到，机器人常会填写 / honeypot: invisible to people, bots tend to fill it
  if (input[HONEYPOT]) return done;

  const errors: Record<string, string[]> = {};
  for (const f of WEB_FORM_FIELDS) {
    const value = input[f];
    if (!form.fields.includes(f)) {
      if (value) errors[f] = ['not_enabled'];
    } else if (form.requiredFields.includes(f) && !value) {
      errors[f] = ['required'];
    }
  }
  if (Object.keys(errors).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid submission', errors);

  // 负责人已停用或已不在组织时不分配 / skip an owner who is inactive or gone
  const owner = form.ownerId ? await prisma.user.findFirst({ where: { id: form.ownerId, organizationId: form.organizationId, isActive: true }, select: { id: true } }) : null;
  const data = Object.fromEntries(WEB_FORM_FIELDS.filter((f) => form.fields.includes(f)).map((f) => [f, input[f] ?? null]));
  await prisma.$transaction(async (tx) => {
    const lead = await tx.lead.create({
      data: { ...data, name: input.name, organizationId: form.organizationId, ownerId: owner?.id ?? null, source: form.source, campaignId: form.campaignId, webFormId: form.id },
    });
    await tx.webForm.update({ where: { id: form.id }, data: { submissionCount: { increment: 1 }, lastSubmittedAt: new Date(now) } });
    await audit(tx, {
      organizationId: form.organizationId,
      actorId: null,
      action: 'lead.create',
      entityType: 'lead',
      entityId: lead.id,
      changes: { after: snapshot('lead', lead), webForm: form.name },
      meta,
    });
    if (lead.ownerId) {
      await tx.notification.create({
        data: { organizationId: form.organizationId, userId: lead.ownerId, type: NotificationType.WEB_FORM_LEAD, leadId: lead.id, title: `${lead.name} · ${form.name}`.slice(0, 200) },
      });
    }
  });
  return done;
}
