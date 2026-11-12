/**
 * 报表测试数据构造（直接写库，精确控制日期与金额）。
 * Report test fixtures written directly to the database for exact dates and amounts.
 */
import { prisma } from '@/server/db';

type Stage = 'QUALIFICATION' | 'NEEDS_ANALYSIS' | 'PROPOSAL' | 'NEGOTIATION' | 'CLOSED_WON' | 'CLOSED_LOST';

/**
 * 报表数据构造器。
 * Report fixture builder bound to one organization.
 */
export async function fixtures(organizationId: string) {
  const account = await prisma.account.create({ data: { organizationId, name: '报表客户' } });
  let n = 0;
  return {
    /** 商机 / deal */
    deal: (stage: Stage, amount: string, opts: { close?: string; currency?: string; ownerId?: string | null } = {}) =>
      prisma.deal.create({
        data: {
          organizationId,
          accountId: account.id,
          name: `商机${++n}`,
          stage,
          amount,
          currency: opts.currency ?? 'CNY',
          ownerId: opts.ownerId ?? null,
          expectedCloseDate: opts.close ? new Date(`${opts.close}T00:00:00Z`) : null,
        },
      }),
    /** 线索 / lead */
    lead: (source: string | null, status: 'NEW' | 'CONVERTED' | 'CONTACTED', createdAt: string, ownerId: string | null = null) =>
      // 已转化线索必须带转化时间（数据库 CHECK）/ converted leads need a conversion time (DB CHECK)
      prisma.lead.create({
        data: { organizationId, name: `线索${++n}`, source, status, ownerId, createdAt: new Date(createdAt), convertedAt: status === 'CONVERTED' ? new Date(createdAt) : null },
      }),
    /** 跟进 / activity */
    activity: (ownerId: string | null, createdAt: string) =>
      prisma.activity.create({ data: { organizationId, type: 'CALL', subject: `跟进${++n}`, ownerId, accountId: account.id, createdAt: new Date(createdAt) } }),
    /** 报价单（无明细，金额直接给定）/ quote with given totals */
    quote: (dealId: string, status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED', total: string, createdAt: string, currency = 'CNY') =>
      prisma.quote.create({
        data: { organizationId, dealId, quoteNumber: `QT-T-${++n}`, subject: '报价', status, currency, subtotal: total, taxAmount: '0', total, createdAt: new Date(createdAt) },
      }),
  };
}
