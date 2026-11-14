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
  tags?: RecordTags;
  createdAt: string;
  updatedAt: string;
}

/** 跟进记录可固定的关联 / Relation an activity form can be pinned to */
export type ActivityRelation = { accountId: string } | { leadId: string } | { dealId: string };

/** 商机 / Deal */
export interface Deal {
  id: string;
  name: string;
  accountId: string;
  account: Ref;
  amount: string;
  currency: string;
  stage: 'QUALIFICATION' | 'NEEDS_ANALYSIS' | 'PROPOSAL' | 'NEGOTIATION' | 'CLOSED_WON' | 'CLOSED_LOST';
  /** 产品明细数量 / number of line items */
  _count?: { lineItems: number };
  tags?: RecordTags;
  expectedCloseDate: string | null;
  description: string | null;
  ownerId: string | null;
  owner: Ref | null;
  createdAt: string;
  updatedAt: string;
}

/** 产品 / Product */
export interface Product {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  unit: string;
  unitPrice: string;
  currency: string;
  description: string | null;
  isActive: boolean;
  _count?: { lineItems: number };
}

/** 商机产品明细 / Deal line item */
export interface DealItem {
  id: string;
  productId: string;
  productName: string;
  productSku: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  lineTotal: string;
  product: { unit: string; isActive: boolean };
}

/** 报价单状态 / Quote status */
export type QuoteStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED';

/** 报价单明细（快照）/ Quote line (snapshot) */
export interface QuoteLine {
  id: string;
  position: number;
  productSku: string;
  productName: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  lineTotal: string;
}

/** 报价单 / Quote */
export interface Quote {
  id: string;
  dealId: string;
  quoteNumber: string;
  subject: string;
  status: QuoteStatus;
  currency: string;
  validUntil: string | null;
  taxPercent: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  terms: string | null;
  notes: string | null;
  sentAt: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; name: string } | null;
  deal: {
    id: string;
    name: string;
    ownerId: string | null;
    stage?: string;
    owner?: { id: string; name: string } | null;
    account: { id: string; name: string; phone?: string | null; address?: string | null };
  };
  organization?: { name: string };
  lines?: QuoteLine[];
  /** 由该报价单生成的订单 / orders generated from this quote */
  salesOrders?: { id: string; orderNumber: string; status: SalesOrderStatus }[];
}

/** 销售订单状态 / Sales order status */
export type SalesOrderStatus = 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';

/** 销售订单 / Sales order */
export interface SalesOrder {
  id: string;
  quoteId: string;
  dealId: string;
  orderNumber: string;
  subject: string;
  status: SalesOrderStatus;
  currency: string;
  taxPercent: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  expectedDelivery: string | null;
  shippingAddress: string | null;
  notes: string | null;
  cancelReason: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; name: string } | null;
  quote: { id: string; quoteNumber: string };
  deal: Quote['deal'];
  organization?: { name: string };
  lines?: QuoteLine[];
  /** 由该订单生成的发票 / invoices generated from this order */
  invoices?: { id: string; invoiceNumber: string; status: InvoiceStatus }[];
}

/** 发票状态 / Invoice status */
export type InvoiceStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'VOID';
/** 收款方式 / Payment method */
export type PaymentMethod = 'BANK_TRANSFER' | 'CASH' | 'CHECK' | 'CARD' | 'OTHER';

/** 收款记录 / Payment */
export interface InvoicePayment {
  id: string;
  amount: string;
  paidOn: string;
  method: PaymentMethod;
  reference: string | null;
  createdAt: string;
  recordedBy: { id: string; name: string } | null;
}

/** 发票 / Invoice */
export interface Invoice {
  id: string;
  salesOrderId: string;
  dealId: string;
  invoiceNumber: string;
  subject: string;
  status: InvoiceStatus;
  currency: string;
  taxPercent: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  paidAmount: string;
  invoiceDate: string;
  dueDate: string;
  billingAddress: string | null;
  notes: string | null;
  voidReason: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  salesOrder: { id: string; orderNumber: string };
  deal: Quote['deal'];
  organization?: { name: string };
  lines?: QuoteLine[];
  payments?: InvoicePayment[];
}

/** 标签 / Tag */
export interface Tag {
  id: string;
  name: string;
  color: string;
  _count?: { leads: number; accounts: number; deals: number };
}

/** 记录上的标签（接口返回结构）/ tags on a record as returned by the API */
export type RecordTags = { tag: Tag }[];
