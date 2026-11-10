/**
 * 前端使用的 API 数据类型。
 * API data types used by the frontend.
 */

/** 简要引用 / Short reference */
export interface Ref {
  id: string;
  name: string;
}

/** 跟进记录 / Activity */
export interface Activity {
  id: string;
  type: 'CALL' | 'MEETING' | 'VISIT' | 'TASK';
  subject: string;
  content: string | null;
  dueAt: string | null;
  completed: boolean;
  completedAt: string | null;
  accountId: string | null;
  leadId: string | null;
  dealId: string | null;
  ownerId: string | null;
  owner: Ref | null;
  account: Ref | null;
  lead: Ref | null;
  deal: Ref | null;
  createdAt: string;
}

/** 联系人 / Contact */
export interface Contact {
  id: string;
  accountId: string;
  name: string;
  title: string | null;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
}

/** 客户 / Account */
export interface Account {
  id: string;
  name: string;
  industry: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  description: string | null;
  ownerId: string | null;
  owner: Ref | null;
  _count: { contacts: number; deals: number };
  contacts?: Contact[];
  createdAt: string;
  updatedAt: string;
}

/** 跟进记录可固定的关联 / Relation an activity form can be pinned to */
export type ActivityRelation = { accountId: string } | { leadId: string } | { dealId: string };
