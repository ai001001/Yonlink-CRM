/**
 * 审计变更内容展示：字段名、枚举值翻译，脱敏值原样显示。
 * Render audit change sets: translated field names and enum values; redacted values shown as-is.
 */
'use client';

import { Space, Typography } from 'antd';
import { t, tEnum, type MessageKey } from '@/i18n';
import { reasonText } from './QuoteApproval';

/** 审计日志条目 / Audit log entry */
export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  changes: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
  actor: { id: string; name: string } | null;
}

// 字段 → 文案 key / field → message key
const FIELD_LABELS: Record<string, MessageKey> = {
  territoryId: 'territories.territory',
  territoryManual: 'territories.manual',
  name: 'leads.name',
  company: 'leads.company',
  title: 'leads.jobTitle',
  phone: 'leads.phone',
  mobile: 'leads.mobile',
  email: 'leads.email',
  source: 'leads.source',
  status: 'leads.status',
  description: 'common.description',
  ownerId: 'common.owner',
  industry: 'accounts.industry',
  website: 'accounts.website',
  address: 'accounts.address',
  isPrimary: 'contacts.isPrimary',
  accountId: 'deals.account',
  amount: 'deals.amount',
  currency: 'deals.currency',
  stage: 'deals.stage',
  expectedCloseDate: 'deals.expectedCloseDate',
  type: 'activities.type',
  subject: 'activities.subject',
  content: 'activities.content',
  dueAt: 'activities.dueAt',
  completed: 'activities.completed',
  leadId: 'activities.lead',
  dealId: 'activities.deal',
  sku: 'products.sku',
  category: 'products.category',
  unit: 'products.unit',
  unitPrice: 'products.unitPrice',
  isActive: 'products.status',
  quoteNumber: 'quotes.number',
  validUntil: 'quotes.validUntil',
  taxPercent: 'quotes.taxPercent',
  subtotal: 'quotes.subtotal',
  taxAmount: 'quotes.taxAmount',
  total: 'quotes.total',
  terms: 'quotes.terms',
  notes: 'quotes.notes',
  orderNumber: 'orders.number',
  quoteId: 'orders.quote',
  expectedDelivery: 'orders.expectedDelivery',
  shippingAddress: 'orders.shippingAddress',
  cancelReason: 'orders.cancelReason',
  campaignId: 'campaigns.source',
  budget: 'campaigns.budget',
  actualCost: 'campaigns.actualCost',
  startDate: 'campaigns.startDate',
  endDate: 'campaigns.endDate',
  invoiceNumber: 'invoices.number',
  salesOrderId: 'invoices.order',
  paidAmount: 'invoices.paidAmount',
  invoiceDate: 'invoices.invoiceDate',
  dueDate: 'invoices.dueDate',
  billingAddress: 'invoices.billingAddress',
  voidReason: 'invoices.voidReason',
  contactRole: 'contactRoles.role',
  competitorName: 'competitors.name',
  threatLevel: 'competitors.threatLevel',
  strengths: 'competitors.strengths',
  weaknesses: 'competitors.weaknesses',
  ticketNumber: 'tickets.number',
  contactId: 'tickets.contact',
  priority: 'tickets.priority',
  channel: 'tickets.channel',
  resolution: 'tickets.resolution',
  resolvedAt: 'tickets.resolvedAt',
  isInternal: 'ticketComments.internal',
  body: 'ticketComments.body',
  escalatedAt: 'sla.escalatedAt',
  contactName: 'vendors.contactName',
  paymentTerms: 'vendors.paymentTerms',
  poNumber: 'purchase.number',
  exchangeRate: 'audit.field.exchangeRate',
  baseTotal: 'audit.field.baseTotal',
  vendorId: 'purchase.vendor',
  expectedDate: 'purchase.expectedDate',
  deliveryAddress: 'purchase.deliveryAddress',
  pricingModel: 'priceBooks.pricingModel',
  tiers: 'priceBooks.tiers',
  listPrice: 'priceBooks.listPrice',
  entries: 'priceBooks.products',
  requiredFields: 'webForms.requiredFields',
  successMessage: 'webForms.successMessage',
  submissionCount: 'webForms.submissions',
  enabled: 'sla.enabled',
  urgentHours: 'sla.urgentHours',
  highHours: 'sla.highHours',
  mediumHours: 'sla.mediumHours',
  lowHours: 'sla.lowHours',
  escalateToId: 'sla.escalateTo',
};

// 枚举字段 → 翻译前缀 / enum field → translation prefix
const ENUM_PREFIX: Record<string, string> = {
  status: 'leadStatus',
  source: 'leadSource',
  industry: 'industry',
  stage: 'dealStage',
  type: 'activityType',
  role: 'role',
  contactRole: 'dealContactRole',
  threatLevel: 'competitorThreat',
};

/**
 * 操作名称，如“线索 · 修改”。
 * Action label, e.g. “Lead · Update”.
 */
export function actionLabel(action: string): string {
  const [entity = '', verb = ''] = action.split('.');
  return `${tEnum('auditEntity', entity)} · ${tEnum('auditAction', verb)}`;
}

/**
 * 字段名称。
 * Field label.
 */
const fieldLabel = (field: string, entityType: string): string => {
  if (entityType === 'contact' && field === 'name') return t('contacts.name');
  if (entityType === 'account' && field === 'name') return t('accounts.name');
  if (entityType === 'deal' && field === 'name') return t('deals.name');
  if (entityType === 'customrecord' && field === 'name') return t('modules.recordName');
  if (entityType === 'note' && field === 'content') return t('notes.title');
  if (entityType === 'user' && field === 'name') return t('users.name');
  if (entityType === 'user' && field === 'email') return t('users.email');
  if (entityType === 'user' && field === 'role') return t('users.role');
  if (entityType === 'user' && field === 'customRoleId') return t('roles.custom');
  if (entityType === 'user' && field === 'isActive') return t('users.status');
  if (entityType === 'account' && field === 'phone') return t('accounts.phone');
  if (entityType === 'product' && field === 'name') return t('products.name');
  if (entityType === 'tag' && field === 'name') return t('tags.name');
  if (entityType === 'target' && field === 'amount') return t('forecasts.target');
  if (entityType === 'tag' && field === 'color') return t('tags.color');
  if (entityType === 'quote' && field === 'subject') return t('quotes.subject');
  if (entityType === 'quote' && field === 'status') return t('quotes.status');
  if (entityType === 'order' && field === 'subject') return t('orders.subject');
  if (entityType === 'order' && field === 'status') return t('orders.status');
  if (entityType === 'order' && field === 'notes') return t('orders.notes');
  if (entityType === 'invoice' && field === 'subject') return t('invoices.subject');
  if (entityType === 'campaign' && field === 'name') return t('campaigns.name');
  if (entityType === 'ticket' && field === 'subject') return t('tickets.subject');
  if (entityType === 'article' && field === 'title') return t('kb.articleTitle');
  if (entityType === 'vendor' && field === 'name') return t('vendors.name');
  if (entityType === 'pricebook' && field === 'name') return t('priceBooks.name');
  if (entityType === 'webform' && field === 'name') return t('webForms.name');
  if (entityType === 'webform' && field === 'title') return t('webForms.formTitle');
  if (entityType === 'webform' && field === 'intro') return t('webForms.intro');
  if (entityType === 'webform' && field === 'fields') return t('webForms.fields');
  if (entityType === 'webform' && field === 'isActive') return t('webForms.status');
  if (entityType === 'webform' && field === 'assignByRule') return t('webForms.assignByRule');
  if (entityType === 'approval') return t(`approvals.field.${field}` as MessageKey);
  if (entityType === 'pricebook' && field === 'isActive') return t('priceBooks.status');
  if (entityType === 'pricebook' && field === 'accounts') return t('priceBooks.accounts');
  if (entityType === 'vendor' && field === 'isActive') return t('vendors.status');
  if (entityType === 'purchase' && field === 'subject') return t('purchase.subject');
  if (entityType === 'purchase' && field === 'status') return t('purchase.status');
  if (entityType === 'purchase' && field === 'notes') return t('common.description');
  if (entityType === 'purchase' && field === 'cancelReason') return t('purchase.cancelReason');
  if (entityType === 'article' && field === 'body') return t('kb.body');
  if (entityType === 'article' && field === 'category') return t('kb.category');
  if (entityType === 'article' && field === 'status') return t('kb.status');
  if (entityType === 'article' && field === 'authorId') return t('kb.author');
  if (entityType === 'ticket' && field === 'status') return t('tickets.status');
  if (entityType === 'ticket' && field === 'type') return t('tickets.type');
  if (entityType === 'ticket' && field === 'dueAt') return t('tickets.dueAt');
  if (entityType === 'campaign' && field === 'status') return t('campaigns.status');
  if (entityType === 'campaign' && field === 'type') return t('campaigns.type');
  if (entityType === 'invoice' && field === 'status') return t('invoices.status');
  if (entityType === 'invoice' && field === 'notes') return t('invoices.notes');
  const key = FIELD_LABELS[field];
  return key ? t(key) : field;
};

/**
 * 单个值的显示。
 * Display a single value.
 */
function value(field: string, v: unknown, users: Map<string, string>, entityType = ''): string {
  if (v === null || v === undefined || v === '') return '—';
  if (v === '[redacted]') return t('audit.redacted');
  if (typeof v === 'boolean') return v ? t('common.yes') : t('common.no');
  if (field === 'ownerId') return users.get(String(v)) ?? String(v).slice(0, 8);
  if (field.endsWith('Id')) return String(v).slice(0, 8);
  if (entityType === 'quote' && field === 'status') return tEnum('quoteStatus', String(v));
  if (entityType === 'order' && field === 'status') return tEnum('orderStatus', String(v));
  if (entityType === 'invoice' && field === 'status') return tEnum('invoiceStatus', String(v));
  if (entityType === 'campaign' && field === 'status') return tEnum('campaignStatus', String(v));
  if (entityType === 'ticket' && field === 'status') return tEnum('ticketStatus', String(v));
  if (entityType === 'article' && field === 'status') return tEnum('kbStatus', String(v));
  if (entityType === 'purchase' && field === 'status') return tEnum('poStatus', String(v));
  if (entityType === 'webform' && (field === 'fields' || field === 'requiredFields') && Array.isArray(v)) {
    return v.length ? v.map((f) => t(`webForms.field.${String(f)}` as MessageKey)).join(t('common.listSep')) : '—';
  }
  if (field === 'pricingModel') return t(`priceBooks.model.${String(v)}` as MessageKey);
  if (field === 'tiers' && Array.isArray(v)) return v.length ? v.join(t('common.listSep')) : '—';
  if (field === 'expectedDate') return String(v).slice(0, 10);
  if (entityType === 'ticket' && field === 'type') return tEnum('ticketType', String(v));
  if (entityType === 'ticket' && field === 'priority') return tEnum('ticketPriority', String(v));
  if (entityType === 'ticket' && field === 'channel') return tEnum('ticketChannel', String(v));
  if (field === 'resolvedAt' || field === 'escalatedAt') return String(v).replace('T', ' ').slice(0, 16);
  if (field === 'escalateToId') return users.get(String(v)) ?? String(v).slice(0, 8);
  if (entityType === 'campaign' && field === 'type') return tEnum('campaignType', String(v));
  if (ENUM_PREFIX[field]) return tEnum(ENUM_PREFIX[field]!, String(v));
  if (field === 'expectedCloseDate' || field === 'validUntil' || field === 'expectedDelivery' || field === 'invoiceDate' || field === 'dueDate' || field === 'startDate' || field === 'endDate') return String(v).slice(0, 10);
  if (field === 'dueAt') return String(v).replace('T', ' ').slice(0, 16);
  return String(v);
}

export function AuditChanges({ entry, users }: { entry: AuditLogEntry; users: Map<string, string> }) {
  const c = entry.changes ?? {};
  const lines: string[] = [];
  const fields = c.fields as Record<string, [unknown, unknown]> | undefined;
  const snap = (c.after ?? c.before) as Record<string, unknown> | undefined;
  if (Array.isArray(c.merged)) {
    // 合并：被合并的记录名称 / merge: names of the merged records
    lines.push(t('duplicates.auditMerged', { names: (c.merged as { name: string }[]).map((m) => m.name).join(t('common.listSep')) }));
  }
  if (entry.entityType === 'target' && typeof c.month === 'string') {
    // 销售目标：负责人 · 月份 · 币种 / sales target: owner · month · currency
    lines.push(`${value('ownerId', c.userId, users)} · ${c.month} · ${String(c.currency ?? '')}`);
  }
  if (entry.entityType === 'invoice' && typeof c.amount === 'string') {
    // 收款或撤销收款：金额与方式 / payment or reversal: amount and method
    lines.push(t('invoices.auditPayment', { amount: c.amount, method: tEnum('paymentMethod', String(c.method ?? '')) }));
  }
  if (typeof c.contact === 'string') {
    // 商机联系人角色：联系人 · 角色 / deal contact role: contact · role
    const role = typeof c.contactRole === 'string' ? ` · ${tEnum('dealContactRole', c.contactRole)}` : '';
    lines.push(`${t('contactRoles.audit', { name: c.contact })}${role}${c.isPrimary === true ? ` · ${t('contactRoles.primary')}` : ''}`);
  }
  if (entry.action === 'ticket.escalate' && typeof c.dueAt === 'string') {
    // 超时升级：原处理期限与通知人数 / escalation: the missed due time and how many were notified
    lines.push(t('sla.auditEscalate', { due: value('dueAt', c.dueAt, users), n: Number(c.notified ?? 0) }));
  }
  if (entry.action === 'purchase.receive' && Array.isArray(c.received)) {
    // 收货：各行 SKU 与数量 / receipt: SKU and quantity per line
    lines.push((c.received as { sku: string; quantity: string }[]).map((r) => `${r.sku} × ${r.quantity}`).join(t('common.listSep')));
  }
  if (entry.entityType === 'scoring') {
    // 评分规则：规则文本前后对比、阈值变化、重算条数 / scoring: rules before → after, thresholds, rescored count
    const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(t('common.listSep')) : '—');
    if (typeof c.entity === 'string') lines.push(t('scoring.auditEntity', { entity: t(`scoring.entity.${c.entity}` as MessageKey) }));
    if (Array.isArray(c.rules)) lines.push(`${t('scoring.rules')}${t('common.colon')}${list(c.rules[0])} → ${list(c.rules[1])}`);
    for (const k of ['hotScore', 'warmScore'] as const) {
      const v = c[k];
      if (Array.isArray(v)) lines.push(`${t(`scoring.${k}`)}${t('common.colon')}${String(v[0])} → ${String(v[1])}`);
    }
    if (typeof c.rescored === 'number') lines.push(t('scoring.auditRescored', { n: c.rescored }));
  }
  if (entry.entityType === 'assignment') {
    // 分配规则：规则文本前后对比 / assignment rules: rule texts before → after
    const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(t('common.sentenceSep')) : '—');
    if (typeof c.count === 'number') lines.push(t('assignment.auditCount', { n: c.count }));
    if (Array.isArray(c.rules)) lines.push(`${t('assignment.rules')}${t('common.colon')}${list(c.rules[0])} → ${list(c.rules[1])}`);
  }
  if (typeof c.assignmentRule === 'string') {
    // 按分配规则分配的线索 / a lead assigned by an assignment rule
    lines.push(t('assignment.auditRule', { rule: c.assignmentRule }));
  }
  if (typeof c.webForm === 'string') {
    // 网页表单生成的线索 / a lead created by a web form
    lines.push(t('webForms.auditFrom', { form: c.webForm }));
  }
  if (entry.entityType === 'pricebook' && typeof c.sku === 'string') {
    // 价格表产品价格：SKU 与价格（修改时为前后价格）/ price book entry: SKU and price (before → after on change)
    const price = Array.isArray(c.listPrice) ? `${value('listPrice', c.listPrice[0], users)} → ${value('listPrice', c.listPrice[1], users)}` : String(c.listPrice ?? '');
    lines.push(`${c.sku}${t('common.colon')}${price}`);
  }
  if (entry.entityType === 'pricebook' && typeof c.account === 'string') {
    // 价格表指定客户 / price book account assignment
    lines.push(typeof c.replaced === 'string' ? t('priceBooks.auditReplaced', { account: c.account, book: c.replaced }) : t('priceBooks.auditAccount', { account: c.account }));
  }
  if (typeof c.article === 'string') {
    // 工单关联文章 / ticket article link
    lines.push(t('kb.auditArticle', { title: c.article }));
  }
  if (typeof c.commentId === 'string') {
    // 工单评论：类型与字数（内容不记录）/ ticket comment: kind and length (content is not recorded)
    const kind = t(c.isInternal === true ? 'ticketComments.internal' : 'ticketComments.external');
    lines.push(typeof c.length === 'number' ? t('ticketComments.audit', { kind, n: c.length }) : kind);
  }
  if (typeof c.competitor === 'string') {
    // 商机竞争对手：名称 · 威胁程度 / deal competitor: name · threat
    const threat = typeof c.threatLevel === 'string' ? ` · ${t('competitors.threatLevel')}${t('common.colon')}${tEnum('competitorThreat', c.threatLevel)}` : '';
    lines.push(`${t('competitors.audit', { name: c.competitor })}${threat}`);
  }
  if (entry.action === 'product.stock_adjust' && Array.isArray(c.stock)) {
    // 库存调整：SKU、变动、前后库存 / stock adjustment: SKU, change and stock before → after
    lines.push(t('stock.auditAdjust', { sku: String(c.sku ?? ''), quantity: String(c.quantity ?? ''), before: String(c.stock[0]), after: String(c.stock[1]) }));
    // 多仓库起：仓库与该仓库的前后库存 / since multi-warehouse: the warehouse and its stock before → after
    if (typeof c.warehouse === 'string' && Array.isArray(c.warehouseStock)) lines.push(t('stock.auditWarehouse', { warehouse: c.warehouse, before: String(c.warehouseStock[0]), after: String(c.warehouseStock[1]) }));
  } else if (entry.action === 'product.stock_transfer') {
    // 仓库调拨 / transfer between warehouses
    lines.push(t('stock.auditTransfer', { sku: String(c.sku ?? ''), quantity: String(c.quantity ?? ''), from: String(c.from ?? ''), to: String(c.to ?? '') }));
  } else if (Array.isArray(c.stock) && c.stock.length) {
    // 收货、发货、取消退回带来的库存变动（多仓库起带仓库代码）/ stock movements from receipts, shipments and returns (with the warehouse since multi-warehouse)
    lines.push(t('stock.auditMovements', { list: (c.stock as { sku: string; quantity: string; warehouse?: string }[]).map((x) => `${x.sku} ${Number(x.quantity) > 0 ? '+' : ''}${x.quantity}${x.warehouse ? ` @${x.warehouse}` : ''}`).join(t('common.listSep')) }));
  }
  if (Array.isArray(c.reasons) && entry.entityType === 'quote') {
    // 报价单提交审批：原因 / quote approval submission: reasons
    lines.push(t('approvals.auditReasons', { list: (c.reasons as string[]).map(reasonText).join(t('common.listSep')) }));
  }
  if ((entry.action === 'quote.approve' || entry.action === 'quote.reject') && typeof c.step === 'number' && typeof c.of === 'number') {
    // 多级审批：第几级 · 级别名称 / multi-level: which level and its name
    lines.push(`${t('approvals.levelOf', { n: c.step, total: c.of })}${typeof c.level === 'string' ? ` · ${c.level}` : ''}`);
  }
  if (c.custom && typeof c.custom === 'object' && !Array.isArray(c.custom)) {
    // 记录的自定义字段变化（文本类已脱敏）/ custom field changes on a record (text-like values redacted)
    const show = (v: unknown) => (v === null || v === undefined ? '—' : v === '[redacted]' ? t('audit.redacted') : typeof v === 'boolean' ? t(v ? 'common.yes' : 'common.no') : String(v));
    const list = Object.entries(c.custom as Record<string, unknown>).map(([label, v]) => (Array.isArray(v) ? `${label}${t('common.colon')}${show(v[0])} → ${show(v[1])}` : `${label}${t('common.colon')}${show(v)}`));
    if (list.length) lines.push(t('customFields.audit', { list: list.join(t('common.listSep')) }));
  }
  if (entry.entityType === 'territory') {
    // 区域：名称；修改列出变化项；删除与重新分配显示客户数 / territory: name; updates list changes; delete and apply show counts
    const name = typeof c.name === 'string' ? c.name : typeof snap?.name === 'string' ? snap.name : null;
    if (name) lines.push(t('territories.auditName', { name }));
    if (fields) {
      const LABEL: Record<string, MessageKey> = { name: 'territories.name', parentId: 'territories.parent', managerId: 'territories.manager', priority: 'territories.priority', match: 'territories.match', conditions: 'territories.rules', memberIds: 'territories.members' };
      lines.push(t('territories.auditChanged', { list: Object.keys(fields).map((f) => (LABEL[f] ? t(LABEL[f]) : f)).join(t('common.listSep')) }));
    }
    if (typeof c.clearedAccounts === 'number') lines.push(t('territories.auditCleared', { count: c.clearedAccounts }));
    if (entry.action === 'territory.apply') lines.push(t('territories.auditApplied', { checked: Number(c.checked ?? 0), changed: Number(c.changed ?? 0) }));
  }
  if (typeof c.transition === 'string' && typeof c.blueprint === 'string') {
    // 流程蓝图转换 / blueprint transition
    const e = entry.entityType === 'lead' ? 'leadStatus' : 'dealStage';
    lines.push(t('blueprints.auditTransition', { blueprint: c.blueprint, transition: c.transition, from: tEnum(e, String(c.from ?? '')), to: tEnum(e, String(c.to ?? '')) }));
  }
  if (typeof c.cadence === 'string' && typeof c.step === 'number' && typeof c.of === 'number') {
    // 销售节奏创建的跟进 / an activity created by a cadence
    lines.push(t('cadences.auditStep', { name: c.cadence, step: c.step, of: c.of }));
  }
  if (c.via === 'portal') {
    // 客户在门户中的操作 / customer actions from the portal
    lines.push(t('portal.auditVia', { contact: String(c.contact ?? '') }));
  }
  if (entry.entityType === 'portal') {
    // 门户：开通、停用、设置 / portal: invitations, disabling, settings
    if (entry.action === 'portal.invite') lines.push(t('portal.auditInvite', { contact: String(c.contact ?? ''), reset: c.reset ? t('portal.auditReset') : '' }));
    else if (entry.action === 'portal.disable') lines.push(t('portal.auditDisable', { contact: String(c.contact ?? ''), n: Number(c.sessions ?? 0) }));
    else if (fields) for (const [f, [b, a]] of Object.entries(fields)) lines.push(`${t(f === 'isEnabled' ? 'portal.enabled' : 'portal.welcome')}${t('common.colon')}${value(f, b, users)} → ${value(f, a, users)}`);
  }
  if (entry.entityType === 'warehouse') {
    // 仓库：代码与名称；修改列出变化项 / warehouse: code and name; updates list the changes
    const snapW = (c.after ?? c.before) as { code?: string; name?: string } | undefined;
    if (snapW) lines.push(`${snapW.code ?? ''} · ${snapW.name ?? ''}`);
    if (fields) for (const [f, [b, a]] of Object.entries(fields)) lines.push(`${t(`warehouses.${f === 'isActive' ? 'active' : f === 'isDefault' ? 'default' : f}` as MessageKey)}${t('common.colon')}${value(f, b, users)} → ${value(f, a, users)}`);
  }
  if (entry.entityType === 'cadence') {
    // 节奏：加入、停止、维护 / cadence: enroll, stop, maintenance
    const name = typeof c.name === 'string' ? c.name : String(snap?.name ?? '');
    if (entry.action === 'cadence.enroll') lines.push(t('cadences.auditEnroll', { name, record: String(c.record ?? '') }));
    else if (entry.action === 'cadence.stop') lines.push(t('cadences.auditStop', { name, record: String(c.record ?? '') }));
    else {
      lines.push(t('cadences.auditName', { name }));
      if (snap && Array.isArray(snap.steps)) for (const s of snap.steps) lines.push(String(s));
      if (fields) {
        const LABEL: Record<string, MessageKey> = { name: 'cadences.name', isActive: 'cadences.active', steps: 'cadences.steps', exitStates: 'cadences.exitStates', entity: 'cadences.entity' };
        lines.push(t('cadences.auditChanged', { list: Object.keys(fields).map((f) => (LABEL[f] ? t(LABEL[f]) : f)).join(t('common.listSep')) }));
      }
    }
  }
  if (entry.entityType === 'blueprint') {
    // 蓝图：名称；新建与删除列出转换；修改列出变化项 / blueprint: name; create/delete list transitions; updates list changes
    lines.push(t('blueprints.auditName', { name: typeof c.name === 'string' ? c.name : String(snap?.name ?? '') }));
    if (snap && Array.isArray(snap.transitions)) for (const tr of snap.transitions) lines.push(String(tr));
    if (fields) {
      const LABEL: Record<string, MessageKey> = { name: 'blueprints.name', isActive: 'blueprints.active', transitions: 'blueprints.transitions', entity: 'blueprints.entity' };
      lines.push(t('blueprints.auditChanged', { list: Object.keys(fields).map((f) => (LABEL[f] ? t(LABEL[f]) : f)).join(t('common.listSep')) }));
    }
  }
  if (entry.entityType === 'macro') {
    // 宏：名称、对象与范围；修改列出变化项；执行显示成功与失败条数 / macro: name, module and scope; updates list changes; runs show counts
    const name = typeof c.name === 'string' ? c.name : typeof snap?.name === 'string' ? snap.name : '';
    if (entry.action === 'macro.run') {
      lines.push(t('macros.audit', { name, ok: Number(c.succeeded ?? 0), fail: Number(c.failed ?? 0) }));
    } else {
      lines.push(t('macros.auditName', { name }));
      if (snap) lines.push(`${tEnum('workflows.entity', String(snap.entity ?? ''))} · ${tEnum('macros.scope', String(snap.scope ?? ''))} · ${t('workflows.auditCount', { n: Array.isArray(snap.actions) ? snap.actions.length : 0 })}`);
      if (fields) {
        const LABEL: Record<string, MessageKey> = { name: 'macros.name', scope: 'macros.scope', actions: 'macros.actions', entity: 'macros.entity' };
        lines.push(t('macros.auditChanged', { list: Object.keys(fields).map((f) => (LABEL[f] ? t(LABEL[f]) : f)).join(t('common.listSep')) }));
      }
    }
  }
  if (entry.entityType === 'customrecord' && typeof c.module === 'string') {
    // 自定义模块记录：所属模块 / custom module record: its module
    lines.push(`${t('modules.module')}${t('common.colon')}${c.module}`);
  }
  const customReport = entry.action.startsWith('customreport.');
  if (customReport) {
    // 自定义报表：名称、对象、共享；修改列出变化项；导出显示格式与行数 / custom reports: name, module, sharing; changes; exports
    const snapR = (c.after ?? c.before) as { name?: string; entity?: string; shared?: boolean } | undefined;
    lines.push(t('customReports.audit', { name: String(snapR?.name ?? c.name ?? '') }));
    if (snapR?.entity) lines.push(`${t('customReports.entity')}${t('common.colon')}${t(`customReports.entity.${snapR.entity}` as MessageKey)}${snapR.shared ? ` · ${t('customReports.shared')}` : ''}`);
    if (fields) {
      const LABEL: Record<string, MessageKey> = { name: 'customReports.name', shared: 'customReports.shared', columns: 'customReports.columns', filters: 'customReports.filters', groupBy: 'customReports.groupBy', measures: 'customReports.measures', chart: 'customReports.chart' };
      lines.push(t('customReports.auditChanged', { list: Object.keys(fields).map((f) => (LABEL[f] ? t(LABEL[f]) : f)).join(t('common.listSep')) }));
    }
    if (entry.action === 'customreport.export') lines.push(t('export.done', { n: Number(c.rows ?? 0) }));
  }
  if (entry.entityType === 'role') {
    // 自定义角色：名称与基础角色；修改列出增减的权限 / custom role: name and base role; updates list added and removed permissions
    const snapR = (c.after ?? c.before) as { name?: string; baseRole?: string; permissions?: string[] } | undefined;
    lines.push(t('roles.audit', { name: String(snapR?.name ?? c.name ?? '') }));
    if (snapR?.baseRole) lines.push(`${t('roles.baseRole')}${t('common.colon')}${tEnum('role', snapR.baseRole)} · ${t('roles.permissionCount', { n: snapR.permissions?.length ?? 0 })}`);
    const list = (v: unknown) => (Array.isArray(v) ? v.map((p) => t(`perm.${p}` as MessageKey)).join(t('common.listSep')) : '');
    if (Array.isArray(c.added) && c.added.length) lines.push(t('roles.auditAdded', { list: list(c.added) }));
    if (Array.isArray(c.removed) && c.removed.length) lines.push(t('roles.auditRemoved', { list: list(c.removed) }));
  }
  if (entry.entityType === 'picklist' && typeof c.field === 'string') {
    // 下拉选项：字段与变化的选项（名称、启用、概率、新增、删除）/ pick list: the field and the changed options
    type O = { value: string; label: string | null; isActive: boolean; probability: number | null };
    const before = (c.before as O[] | undefined) ?? [];
    const after = (c.after as O[] | undefined) ?? [];
    const prefix = ({ LEAD_SOURCE: 'leadSource', INDUSTRY: 'industry', LEAD_STATUS: 'leadStatus', DEAL_STAGE: 'dealStage', ACTIVITY_TYPE: 'activityType' } as Record<string, string>)[c.field] ?? '';
    const name = (o: O) => o.label ?? tEnum(prefix, o.value);
    lines.push(t('picklists.audit', { field: t(`picklists.field.${c.field}` as MessageKey) }));
    const changed = [
      ...after.filter((o) => JSON.stringify(o) !== JSON.stringify(before.find((x) => x.value === o.value))).map(name),
      ...before.filter((o) => !after.some((x) => x.value === o.value)).map((o) => `${name(o)}${t('common.parens', { text: t('picklists.remove') })}`),
    ];
    if (changed.length) lines.push(t('picklists.auditChanged', { list: changed.join(t('common.listSep')) }));
  }
  if (entry.entityType === 'module') {
    // 自定义模块：名称；修改列出变化；字段的新建、修改、删除 / module: name; updates; field create, update and delete
    const snapM = (c.after ?? c.before) as { name?: string } | undefined;
    lines.push(t('modules.auditName', { name: String(snapM?.name ?? c.name ?? '') }));
    const f = c.field as { label?: string; type?: string } | undefined;
    if (f) lines.push(t('modules.auditField', { label: String(f.label ?? ''), type: tEnum('customFields.type', String(f.type ?? '')) }));
    if (typeof c.cleared === 'number') lines.push(t('customFields.deleted', { n: c.cleared }));
    if (fields) {
      const LABEL: Record<string, MessageKey> = { name: 'modules.name', description: 'modules.description', isActive: 'modules.active', label: 'customFields.label', options: 'customFields.options', required: 'customFields.required' };
      const list = Object.entries(fields).map(([k, [b, a]]) => `${LABEL[k] ? t(LABEL[k]) : k}${t('common.colon')}${Array.isArray(b) ? b.join('/') : value(k, b, users)} → ${Array.isArray(a) ? a.join('/') : value(k, a, users)}`);
      lines.push(typeof c.key === 'string' ? t('modules.auditFieldChanged', { key: c.key, list: list.join(t('common.listSep')) }) : list.join(t('common.listSep')));
    }
  }
  if (entry.entityType === 'customfield') {
    // 自定义字段定义：对象、名称、类型；修改列出变化项 / definitions: entity, name, type; updates list changes
    const d = (c.after ?? c.before) as { entity?: string; label?: string; type?: string } | undefined;
    if (d) lines.push(`${tEnum('customFields.entity', d.entity ?? '')} · ${d.label ?? ''} · ${tEnum('customFields.type', d.type ?? '')}`);
    if (typeof c.cleared === 'number') lines.push(t('customFields.deleted', { n: c.cleared }));
  }
  if (typeof c.approvalCleared === 'string') lines.push(t('approvals.auditCleared', { status: tEnum('approvalStatus', c.approvalCleared) }));
  if ((entry.entityType === 'apikey' || entry.entityType === 'webhook') && typeof c.name === 'string') {
    // API 密钥与 Webhook：名称、前缀或地址（从不记录密钥）/ keys and webhooks: name, prefix or URL (never secrets)
    lines.push(`${t('integrations.name')}${t('common.colon')}${c.name}${typeof c.prefix === 'string' ? ` · ${c.prefix}…` : ''}${typeof c.url === 'string' ? ` · ${c.url}` : ''}`);
  }
  if (entry.entityType === 'workflow' || entry.entityType === 'validation') {
    // 工作流与验证规则：执行结果；规则快照只显示名称、对象、触发时机；修改只列出变化的项
    // workflows: run results; rule snapshots show name, module and trigger; updates list the changed items
    const list = (v: unknown) => (Array.isArray(v) ? v.join(t('common.listSep')) : '');
    if (entry.action === 'workflow.run') {
      lines.push(t('workflows.auditRun', { rule: String(c.rule ?? ''), record: String(c.record ?? '') }));
      if (Array.isArray(c.actions) && c.actions.length) lines.push(t('workflows.auditActions', { list: list(c.actions) }));
      if (Array.isArray(c.skipped)) lines.push(t('workflows.auditSkipped', { list: list(c.skipped) }));
    } else if (snap) {
      lines.push(`${t('workflows.name')}${t('common.colon')}${String(snap.name ?? '')}`);
      const trigger = typeof snap.trigger === 'string' ? ` · ${tEnum('workflows.trigger', snap.trigger)}` : '';
      lines.push(`${t('workflows.entityLabel')}${t('common.colon')}${tEnum('workflows.entity', String(snap.entity ?? ''))}${trigger}`);
      if (typeof snap.message === 'string') lines.push(`${t('validationRules.message')}${t('common.colon')}${snap.message}`);
    } else if (fields) {
      const LABEL: Record<string, MessageKey> = { name: 'workflows.name', trigger: 'workflows.triggerLabel', triggerField: 'workflows.triggerField', conditions: 'workflows.conditions', actions: 'workflows.actions', isActive: 'workflows.active', when: 'validationRules.when', require: 'validationRules.require', message: 'validationRules.message', errorField: 'validationRules.errorField' };
      // 条件、动作显示条数；触发时机显示名称 / conditions and actions show counts; the trigger shows its name
      const show = (f: string, v: unknown) => (Array.isArray(v) ? t('workflows.auditCount', { n: v.length }) : f === 'trigger' ? tEnum('workflows.trigger', String(v)) : value(f, v, users));
      for (const [f, [b, a]] of Object.entries(fields)) lines.push(`${LABEL[f] ? t(LABEL[f]) : f}${t('common.colon')}${show(f, b)} → ${show(f, a)}`);
    }
  } else if (fields && !customReport && entry.entityType !== 'role' && entry.entityType !== 'module' && entry.entityType !== 'territory' && entry.entityType !== 'macro' && entry.entityType !== 'blueprint' && entry.entityType !== 'cadence' && entry.entityType !== 'portal' && entry.entityType !== 'warehouse') {
    for (const [f, [b, a]] of Object.entries(fields)) lines.push(`${fieldLabel(f, entry.entityType)}${t('common.colon')}${value(f, b, users, entry.entityType)} → ${value(f, a, users, entry.entityType)}`);
  } else if (snap && !customReport && entry.entityType !== 'role' && entry.entityType !== 'customfield' && entry.entityType !== 'module' && entry.entityType !== 'picklist' && entry.entityType !== 'territory' && entry.entityType !== 'macro' && entry.entityType !== 'blueprint' && entry.entityType !== 'cadence' && entry.entityType !== 'warehouse') {
    for (const [f, v] of Object.entries(snap)) if (v !== null) lines.push(`${fieldLabel(f, entry.entityType)}${t('common.colon')}${value(f, v, users, entry.entityType)}`);
  } else if (typeof c.reason === 'string') {
    lines.push(tEnum('auditReason', c.reason));
  } else if (typeof c.name === 'string' && /\.(restore|purge|expire)$/.test(entry.action)) {
    // 回收站操作 / recycle-bin actions
    lines.push(`${t('recycle.record')}${t('common.colon')}${c.name}`);
  } else if (entry.entityType !== 'role' && (Array.isArray(c.added) || Array.isArray(c.removed))) {
    // 标签变化 / tag changes
    const added = (c.added as string[] | undefined) ?? [];
    const removed = (c.removed as string[] | undefined) ?? [];
    if (added.length) lines.push(t('tags.auditAdded', { names: added.join(t('common.listSep')) }));
    if (removed.length) lines.push(t('tags.auditRemoved', { names: removed.join(t('common.listSep')) }));
  } else if (entry.action === 'lead.convert') {
    lines.push(`${t('nav.accounts')}${t('common.colon')}${value('accountId', c.accountId, users)}`);
    if (c.dealId) lines.push(`${t('nav.deals')}${t('common.colon')}${value('dealId', c.dealId, users)}`);
  }
  if (c.report === 'receivables') {
    // 应收账款导出：币种、行数、是否截断 / receivables export: currency, rows, truncation
    const f = (c.filters ?? {}) as { currency?: string };
    lines.push(t(c.truncated ? 'receivables.auditExportTruncated' : 'receivables.auditExport', { currency: f.currency ?? '', count: Number(c.count ?? 0) }));
  }
  if (entry.action === 'report.export' && (c.report === 'sales' || c.report === 'forecast')) {
    // 报表导出：报表名与主要筛选 / report export: report name and main filters
    const f = (c.filters ?? {}) as { currency?: string; from?: string; to?: string; period?: string };
    const scope = c.report === 'sales' ? `${f.from ?? ''} ~ ${f.to ?? ''}` : (f.period ?? '');
    lines.push(t('reportExport.audit', { report: t(c.report === 'sales' ? 'reports.title' : 'forecasts.title'), currency: f.currency ?? '', scope }));
  }
  if (typeof c.via === 'string') lines.push(t('audit.via', { via: actionLabel(c.via) }));
  if (typeof c.workflow === 'string') lines.push(t('workflows.auditVia', { rule: c.workflow }));
  if (!lines.length) return null;
  return (
    <Space orientation="vertical" size={0}>
      {lines.map((l, i) => (
        <Typography.Text key={i} style={{ fontSize: 12 }}>
          {l}
        </Typography.Text>
      ))}
    </Space>
  );
}
