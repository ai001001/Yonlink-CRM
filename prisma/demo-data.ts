/**
 * 演示数据（纯数据，无数据库依赖）：虚构的涡轮增压器售后市场企业。
 * 产品线与销售场景参考公开的行业信息（整机增压器、中间体/CHRA、核心部件、配件、维修工具；AAPEX / SEMA / 上海法兰克福汽配展），
 * 所有公司、客户、联系人均为虚构，名称带【演示】；网站使用保留域名 .example，电话使用 555 保留号段。
 * Demo data (pure data, no DB access): a fictional turbocharger-aftermarket company. Product lines and sales
 * scenarios follow public industry information; every company, customer and contact is fictional and labelled
 * 【演示】; websites use the reserved .example TLD and phone numbers the reserved 555 range.
 */
import { createHash } from 'node:crypto';

/** 演示组织名称 / Demo organization name */
export const DEMO_ORG_NAME = '演示涡轮增压器有限公司（演示数据）';
/** 旧版演示组织名称（升级时改名复用）/ Legacy demo organization name (renamed on upgrade) */
export const LEGACY_DEMO_ORG_NAMES = ['演示企业（演示数据）'];

/** 演示账号 / Demo accounts */
export const DEMO_USERS = [
  { key: 'admin', name: '林管理', email: 'admin@demo.yonlink.test', role: 'ADMIN' },
  { key: 'manager', name: '郑经理', email: 'manager@demo.yonlink.test', role: 'MANAGER' },
  { key: 'sales1', name: '王芳', email: 'sales1@demo.yonlink.test', role: 'SALES' },
  { key: 'sales2', name: '陈静', email: 'sales2@demo.yonlink.test', role: 'SALES' },
  { key: 'viewer', name: '周会计', email: 'viewer@demo.yonlink.test', role: 'READONLY' },
] as const;

export type OwnerKey = 'manager' | 'sales1' | 'sales2';
type Industry = 'MANUFACTURING' | 'RETAIL' | 'LOGISTICS' | 'OTHER';
type Stage = 'QUALIFICATION' | 'NEEDS_ANALYSIS' | 'PROPOSAL' | 'NEGOTIATION' | 'CLOSED_WON' | 'CLOSED_LOST';
type LeadStatus = 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'UNQUALIFIED' | 'CONVERTED';
type LeadSource = 'WEBSITE' | 'REFERRAL' | 'EXHIBITION' | 'COLD_CALL' | 'ADVERTISEMENT' | 'SOCIAL_MEDIA' | 'OTHER';
type ActivityType = 'CALL' | 'MEETING' | 'VISIT' | 'TASK';

/** 可复现的伪随机数（mulberry32）/ Reproducible PRNG (mulberry32) */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 产品线 / Product lines */
const PRODUCTS = [
  { key: 'hd', label: '重型柴油机涡轮增压器（4.0–12.0L）', short: '重卡增压器', min: 80_000, max: 600_000 },
  { key: 'pc', label: '乘用车柴油机涡轮增压器（0.8–3.5L）', short: '乘用车柴油增压器', min: 30_000, max: 220_000 },
  { key: 'petrol', label: '汽油机涡轮增压器（1.0–2.0L）', short: '汽油机增压器', min: 25_000, max: 180_000 },
  { key: 'chra', label: '中间体 / 芯组件（CHRA）', short: '中间体 CHRA', min: 20_000, max: 160_000 },
  { key: 'parts', label: '核心部件（轴轮、压气机轮、轴承壳、喷嘴环）', short: '核心部件', min: 10_000, max: 90_000 },
  { key: 'acc', label: '配件（垫片套件、油管、螺柱、卡箍）', short: '配件套装', min: 4_000, max: 40_000 },
  { key: 'tools', label: '维修工具（平衡、装配、检测）', short: '维修工具', min: 3_000, max: 25_000 },
] as const;

/** 客户（虚构）/ Accounts (fictional) */
interface AccountSeed {
  key: string;
  name: string;
  industry: Industry;
  region: string;
  city: string;
  currency: 'USD' | 'EUR' | 'CNY';
  owner: OwnerKey;
  domain: string;
  phone: string;
  products: (typeof PRODUCTS)[number]['key'][];
  contacts: { name: string; title: string }[];
}

const A = (
  key: string,
  name: string,
  industry: Industry,
  region: string,
  city: string,
  currency: AccountSeed['currency'],
  owner: OwnerKey,
  domain: string,
  phone: string,
  products: AccountSeed['products'],
  contacts: [string, string][],
): AccountSeed => ({
  key,
  name: `【演示】${name}`,
  industry,
  region,
  city,
  currency,
  owner,
  domain: `${domain}.example`,
  phone,
  products,
  contacts: contacts.map(([n, t]) => ({ name: n, title: t })),
});

export const ACCOUNTS: AccountSeed[] = [
  // 北美 / 欧洲：王芳 / North America & Europe: 王芳
  A('northlake', '北湖商用车配件分销公司', 'RETAIL', '北美', '芝加哥', 'USD', 'sales1', 'northlake-truckparts', '+1 312 555 0141', ['hd', 'chra', 'acc'], [['Michael Turner', '采购总监'], ['Laura Simmons', '产品经理'], ['Kevin Brooks', '仓储主管']]),
  A('lonestar', '孤星重卡维修连锁', 'LOGISTICS', '北美', '达拉斯', 'USD', 'sales1', 'lonestar-fleet', '+1 214 555 0177', ['hd', 'tools'], [['Daniel Price', '运营副总裁'], ['Megan Hall', '采购专员']]),
  A('greatplains', '大平原涡轮再制造厂', 'MANUFACTURING', '北美', '堪萨斯城', 'USD', 'sales1', 'greatplains-reman', '+1 816 555 0109', ['chra', 'parts', 'tools'], [['Robert King', '总经理'], ['Ashley Moore', '技术主管']]),
  A('pacific', '太平洋汽配进口商', 'RETAIL', '北美', '洛杉矶', 'USD', 'sales1', 'pacific-autoimport', '+1 213 555 0163', ['pc', 'petrol', 'acc'], [['Brian Lee', '品类经理'], ['Jessica Wong', '采购经理']]),
  A('maple', '枫叶车队服务公司', 'LOGISTICS', '北美', '多伦多', 'USD', 'sales1', 'maple-fleetservice', '+1 416 555 0128', ['hd', 'acc'], [['Ryan Campbell', '车队维修经理'], ['Emily Scott', '采购员']]),
  A('rhein', '莱茵汽配进出口公司', 'RETAIL', '欧洲', '杜塞尔多夫', 'EUR', 'sales1', 'rhein-autoparts', '+49 211 555 0182', ['pc', 'chra', 'acc'], [['Thomas Becker', '采购经理'], ['Anna Schmidt', '质量工程师'], ['Lukas Weber', '销售总监']]),
  A('lyon', '里昂涡轮服务中心', 'MANUFACTURING', '欧洲', '里昂', 'EUR', 'sales1', 'lyon-turboservice', '+33 4 555 0190', ['chra', 'parts', 'tools'], [['Pierre Martin', '技术总监'], ['Claire Dubois', '采购主管']]),
  A('baltic', '波罗的海卡车配件公司', 'RETAIL', '欧洲', '格但斯克', 'EUR', 'sales1', 'baltic-truckparts', '+48 58 555 0136', ['hd', 'acc'], [['Piotr Nowak', '总经理'], ['Agnieszka Lis', '采购']]),
  A('iberia', '伊比利亚汽车部件分销商', 'RETAIL', '欧洲', '巴伦西亚', 'EUR', 'sales1', 'iberia-autodist', '+34 96 555 0151', ['petrol', 'pc'], [['Javier Ruiz', '品类经理'], ['Lucía Gómez', '采购专员']]),
  A('nordic', '北欧动力再制造公司', 'MANUFACTURING', '欧洲', '哥德堡', 'EUR', 'sales1', 'nordic-powerreman', '+46 31 555 0117', ['chra', 'parts'], [['Erik Lindqvist', '生产经理'], ['Sara Holm', '采购']]),
  // 东南亚 / 中东 / 南美 / 非洲：陈静 / SEA, Middle East, South America, Africa: 陈静
  A('nanyang', '南洋汽车配件贸易行', 'RETAIL', '东南亚', '新加坡', 'USD', 'sales2', 'nanyang-autotrade', '+65 6555 0148', ['pc', 'petrol', 'acc'], [['陈国伟', '董事经理'], ['林美玲', '采购经理']]),
  A('saigon', '西贡柴油机服务公司', 'LOGISTICS', '东南亚', '胡志明市', 'USD', 'sales2', 'saigon-dieselservice', '+84 28 555 0122', ['hd', 'chra'], [['Nguyen Van Minh', '总经理'], ['Tran Thi Lan', '采购']]),
  A('bangkok', '曼谷涡轮专修中心', 'MANUFACTURING', '东南亚', '曼谷', 'USD', 'sales2', 'bangkok-turbo', '+66 2 555 0174', ['chra', 'parts', 'tools'], [['Somchai Wong', '技术经理'], ['Ploy Srisuk', '采购主管']]),
  A('jakarta', '雅加达重卡配件公司', 'RETAIL', '东南亚', '雅加达', 'USD', 'sales2', 'jakarta-truckparts', '+62 21 555 0159', ['hd', 'acc'], [['Budi Santoso', '总经理'], ['Dewi Lestari', '采购']]),
  A('manila', '马尼拉汽配连锁', 'RETAIL', '东南亚', '马尼拉', 'USD', 'sales2', 'manila-autochain', '+63 2 555 0131', ['pc', 'acc'], [['Jose Reyes', '品类经理'], ['Maria Santos', '采购员']]),
  A('gulf', '海湾重卡服务连锁', 'LOGISTICS', '中东', '迪拜', 'USD', 'sales2', 'gulf-heavyservice', '+971 4 555 0186', ['hd', 'tools', 'acc'], [['Ahmed Al-Farsi', '运营总监'], ['Omar Haddad', '采购经理'], ['Sami Nasser', '维修主管']]),
  A('riyadh', '利雅得工程机械配件公司', 'RETAIL', '中东', '利雅得', 'USD', 'sales2', 'riyadh-equipparts', '+966 11 555 0144', ['hd', 'chra'], [['Khalid Al-Otaibi', '总经理'], ['Faisal Rahman', '采购']]),
  A('anatolia', '安纳托利亚涡轮再制造', 'MANUFACTURING', '中东', '伊斯坦布尔', 'USD', 'sales2', 'anatolia-turboreman', '+90 212 555 0119', ['chra', 'parts'], [['Mehmet Yilmaz', '工厂经理'], ['Ayse Demir', '采购主管']]),
  A('saopaulo', '圣保罗柴油动力配件公司', 'RETAIL', '南美', '圣保罗', 'USD', 'sales2', 'saopaulo-dieselparts', '+55 11 555 0170', ['hd', 'pc', 'acc'], [['Carlos Silva', '采购总监'], ['Fernanda Costa', '品类经理']]),
  A('andes', '安第斯矿用车辆服务公司', 'LOGISTICS', '南美', '圣地亚哥', 'USD', 'sales2', 'andes-miningfleet', '+56 2 555 0153', ['hd', 'tools'], [['Diego Fernández', '车队经理'], ['Valentina Rojas', '采购']]),
  A('lagos', '拉各斯汽车部件贸易公司', 'RETAIL', '非洲', '拉各斯', 'USD', 'sales2', 'lagos-autoparts', '+234 1 555 0127', ['pc', 'acc'], [['Chinedu Okafor', '总经理'], ['Amaka Eze', '采购']]),
  // 国内重点客户：郑经理 / Domestic key accounts: 郑经理
  A('huadong', '华东涡轮再制造中心', 'MANUFACTURING', '国内', '常州', 'CNY', 'manager', 'huadong-reman', '0519-5550-1188', ['chra', 'parts', 'tools'], [['周建国', '总经理'], ['吴晓燕', '采购经理'], ['孙浩', '技术主管']]),
  A('beifang', '北方重卡配件集团', 'RETAIL', '国内', '济南', 'CNY', 'manager', 'beifang-truckparts', '0531-5550-2266', ['hd', 'acc'], [['刘志强', '副总经理'], ['张丽', '采购总监']]),
  A('xinan', '西南工程机械服务公司', 'LOGISTICS', '国内', '成都', 'CNY', 'manager', 'xinan-machinery', '028-5550-3344', ['hd', 'chra', 'tools'], [['王磊', '服务总监'], ['何静', '采购']]),
  A('huanan', '华南汽配连锁', 'RETAIL', '国内', '广州', 'CNY', 'manager', 'huanan-autochain', '020-5550-4455', ['pc', 'petrol', 'acc'], [['陈伟', '品类总监'], ['黄敏', '采购经理']]),
  A('dongbei', '东北客车动力维修公司', 'LOGISTICS', '国内', '长春', 'CNY', 'manager', 'dongbei-busservice', '0431-5550-5566', ['hd', 'parts'], [['赵刚', '维修经理'], ['李娜', '采购']]),
  A('zhongyuan', '中原柴油机配件公司', 'RETAIL', '国内', '郑州', 'CNY', 'manager', 'zhongyuan-diesel', '0371-5550-6677', ['hd', 'chra', 'acc'], [['杨帆', '总经理'], ['郭倩', '采购主管']]),
  A('xibei', '西北运输车队管理公司', 'LOGISTICS', '国内', '西安', 'CNY', 'manager', 'xibei-fleet', '029-5550-7788', ['hd', 'tools'], [['马军', '车队经理'], ['高原', '采购']]),
  A('jiangnan', '江南乘用车维修连锁', 'OTHER', '国内', '杭州', 'CNY', 'manager', 'jiangnan-carcare', '0571-5550-8899', ['petrol', 'pc', 'tools'], [['沈杰', '技术总监'], ['钱芳', '采购经理']]),
  A('haixi', '海西进出口贸易公司', 'RETAIL', '国内', '厦门', 'CNY', 'manager', 'haixi-trading', '0592-5550-9900', ['chra', 'acc'], [['林志明', '总经理'], ['蔡雅琪', '跟单主管']]),
];

/** 线索公司（尚未成为客户的潜在客户）/ Lead prospects (not yet accounts) */
const PROSPECTS: [string, string, string, OwnerKey][] = [
  ['Silverline Diesel Supply', '北美', 'Mark Johnson', 'sales1'],
  ['Redwood Truck Center', '北美', 'Paul Anderson', 'sales1'],
  ['Atlantic Turbo Rebuilders', '北美', 'Sandra Lewis', 'sales1'],
  ['Prairie Fleet Maintenance', '北美', 'Greg Walker', 'sales1'],
  ['Desert Highway Parts', '北美', 'Nancy Young', 'sales1'],
  ['Alpen Kfz-Teile', '欧洲', 'Stefan Huber', 'sales1'],
  ['Mediterranea Ricambi', '欧洲', 'Marco Rossi', 'sales1'],
  ['Thames Commercial Parts', '欧洲', 'Oliver Wright', 'sales1'],
  ['Flandre Turbo Atelier', '欧洲', 'Julien Petit', 'sales1'],
  ['Danube Truck Service', '欧洲', 'Andrei Popescu', 'sales1'],
  ['Carpathia Auto Distribution', '欧洲', 'Tomas Novak', 'sales1'],
  ['Pacific Rim Diesel', '北美', 'Steven Clark', 'sales1'],
  ['Hanoi Motor Parts', '东南亚', 'Le Quang Huy', 'sales2'],
  ['Penang Turbo Workshop', '东南亚', 'Tan Wei Ming', 'sales2'],
  ['Cebu Fleet Supply', '东南亚', 'Ramon Cruz', 'sales2'],
  ['Mandalay Engine Service', '东南亚', 'Aung Kyaw', 'sales2'],
  ['Doha Heavy Equipment', '中东', 'Yousef Karim', 'sales2'],
  ['Muscat Truck Parts', '中东', 'Hamad Al-Said', 'sales2'],
  ['Amman Diesel Center', '中东', 'Rami Khoury', 'sales2'],
  ['Lima Turbo Service', '南美', 'Alejandro Torres', 'sales2'],
  ['Bogotá Repuestos Diesel', '南美', 'Camilo Herrera', 'sales2'],
  ['Buenos Aires Turbo', '南美', 'Martín Acosta', 'sales2'],
  ['Nairobi Auto Spares', '非洲', 'Peter Kamau', 'sales2'],
  ['Casablanca Pièces Auto', '非洲', 'Youssef Benali', 'sales2'],
  ['Johannesburg Fleet Parts', '非洲', 'Thabo Nkosi', 'sales2'],
  ['昆明高原车辆服务', '国内', '段宏', 'manager'],
  ['青岛港口物流车队', '国内', '于海涛', 'manager'],
  ['合肥涡轮修理厂', '国内', '许亮', 'manager'],
  ['南宁汽配城商户', '国内', '韦春', 'manager'],
  ['乌鲁木齐重卡服务站', '国内', '艾力', 'manager'],
  ['武汉汽车后市场平台', '国内', '彭博', 'manager'],
  ['太原煤运车队', '国内', '郝建平', 'manager'],
  ['长沙工程机械租赁', '国内', '谭勇', 'manager'],
  ['福州乘用车快修连锁', '国内', '郑凯', 'manager'],
  ['兰州柴油机维修中心', '国内', '牛强', 'manager'],
  ['宁波外贸汽配公司', '国内', '应佳', 'manager'],
  ['Saint Petersburg Truck Parts', '欧洲', 'Ivan Petrov', 'sales1'],
  ['Kraków Motor Service', '欧洲', 'Marek Wójcik', 'sales1'],
  ['Montreal Fleet Garage', '北美', 'Luc Tremblay', 'sales1'],
  ['Phoenix Turbo Exchange', '北美', 'Hector Ramirez', 'sales1'],
  ['Kuala Lumpur Diesel Hub', '东南亚', 'Ahmad Faiz', 'sales2'],
  ['Colombo Auto Traders', '东南亚', 'Nuwan Perera', 'sales2'],
  ['Karachi Truck Bazaar', '中东', 'Imran Qureshi', 'sales2'],
  ['Quito Motor Parts', '南美', 'Andrés Vega', 'sales2'],
  ['Accra Engine Supply', '非洲', 'Kwame Mensah', 'sales2'],
  ['大连船舶动力配件', '国内', '曲波', 'manager'],
  ['石家庄重卡4S店', '国内', '冯军', 'manager'],
  ['贵阳山区客运公司', '国内', '罗刚', 'manager'],
];

const LEAD_HOOKS = [
  { source: 'EXHIBITION', text: 'AAPEX 展位洽谈，关注北美商用车售后增压器' },
  { source: 'EXHIBITION', text: 'SEMA 展会交流，询问高性能汽油机增压器' },
  { source: 'EXHIBITION', text: '上海法兰克福汽配展留下名片，需要 CHRA 产品目录' },
  { source: 'WEBSITE', text: '官网询盘：要求提供重卡增压器报价与交期' },
  { source: 'WEBSITE', text: '官网在线目录查询后留言，咨询配件套装起订量' },
  { source: 'REFERRAL', text: '现有客户推荐，计划替换现有供应商' },
  { source: 'COLD_CALL', text: '电话开发，客户正在评估第二供应商' },
  { source: 'SOCIAL_MEDIA', text: '领英私信，询问维修工具与培训支持' },
  { source: 'ADVERTISEMENT', text: '行业杂志广告回复，索取样品' },
] as const;

const LEAD_STATUS_CYCLE: LeadStatus[] = ['NEW', 'CONTACTED', 'CONTACTED', 'QUALIFIED', 'NEW', 'UNQUALIFIED', 'CONTACTED', 'QUALIFIED'];

/** 线索 / Leads */
export interface LeadSeed {
  name: string;
  company: string;
  title: string;
  owner: OwnerKey;
  source: LeadSource;
  status: LeadStatus;
  email: string;
  phone: string;
  description: string;
  daysAgo: number;
  /** 已转化为该商机（演示转化结果）/ converted into this deal (demo conversion result) */
  convertedDeal?: string;
}

/** 商机 / Deals */
export interface DealSeed {
  key: string;
  account: string;
  name: string;
  amount: string;
  currency: AccountSeed['currency'];
  stage: Stage;
  /** 相对今天的预计成交日期偏移（天）/ expected close date offset from today (days) */
  closeInDays: number;
  owner: OwnerKey;
  description: string;
  /** 产品线（用于生成产品明细）/ product line (used for line items) */
  productLine: (typeof PRODUCTS)[number]['key'];
}

/** 备注 / Notes */
export interface NoteSeed {
  owner: OwnerKey;
  deal?: string;
  account?: string;
  content: string;
  daysAgo: number;
}

/** 跟进 / Activities */
export interface ActivitySeed {
  type: ActivityType;
  subject: string;
  content: string;
  owner: OwnerKey;
  deal?: string;
  account?: string;
  lead?: number;
  /** 创建于几天前 / created N days ago */
  daysAgo: number;
  /** 截止日期偏移（天，可为负表示已逾期）/ due offset in days (negative = overdue) */
  dueInDays: number | null;
  completed: boolean;
}

const STAGE_PLAN: { stage: Stage; close: [number, number] }[] = [
  { stage: 'QUALIFICATION', close: [60, 180] },
  { stage: 'NEEDS_ANALYSIS', close: [45, 150] },
  { stage: 'PROPOSAL', close: [20, 90] },
  { stage: 'NEGOTIATION', close: [7, 45] },
  // 已结束商机分布在过去约 11 个月，报表按月趋势更有意义 / closed deals spread over ~11 months for monthly trends
  { stage: 'CLOSED_WON', close: [-330, -3] },
  { stage: 'CLOSED_LOST', close: [-330, -10] },
];

/** 客户简称（用于商机名称）/ Account short names used in deal names */
const SHORT_NAMES: Record<string, string> = {
  northlake: '北湖配件', lonestar: '孤星重卡', greatplains: '大平原再制造', pacific: '太平洋汽配', maple: '枫叶车队',
  rhein: '莱茵汽配', lyon: '里昂涡轮', baltic: '波罗的海卡车', iberia: '伊比利亚汽配', nordic: '北欧动力',
  nanyang: '南洋汽配', saigon: '西贡柴油机', bangkok: '曼谷涡轮', jakarta: '雅加达重卡', manila: '马尼拉汽配',
  gulf: '海湾重卡', riyadh: '利雅得机械', anatolia: '安纳托利亚再制造', saopaulo: '圣保罗动力', andes: '安第斯矿车',
  lagos: '拉各斯汽配', huadong: '华东再制造', beifang: '北方重卡', xinan: '西南机械', huanan: '华南汽配',
  dongbei: '东北客车', zhongyuan: '中原柴油机', xibei: '西北车队', jiangnan: '江南汽修', haixi: '海西贸易',
};

const DEAL_QUALIFIERS = ['年度框架采购', '首批试单', '季度补货', '新车型配套项目', '库存补充订单', '替换供应商项目'];
const LOST_REASONS = ['价格高于竞争对手约 8%', '客户预算推迟到下一年度', '交期无法满足旺季需求', '客户选择了本地供应商'];

/** 产品 / Product */
export interface ProductSeed {
  sku: string;
  name: string;
  category: string;
  unit: string;
  unitPrice: string;
  currency: 'USD' | 'CNY';
}

/** 商机产品明细 / Deal line item */
export interface DealItemSeed {
  deal: string;
  sku: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  lineTotal: string;
}

/**
 * 商机创建于几天前：进行中商机 20–69 天前；已结束商机在预计成交日期之前 20–69 天。
 * Days since a deal was created: 20–69 days for open deals; 20–69 days before the close date for closed deals.
 */
export function dealCreatedDaysAgo(d: Pick<DealSeed, 'closeInDays'>): number {
  const lead = (Math.abs(d.closeInDays) % 50) + 20;
  return d.closeInDays < 0 ? -d.closeInDays + lead : lead;
}

/** 报价单（明细由商机产品明细生成；报价单号在写入时按年份编号）/ Quote (lines come from the deal items) */
export interface QuoteSeed {
  deal: string;
  status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED';
  taxPercent: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  /** 创建于几天前 / created N days ago */
  daysAgo: number;
  /** 有效期相对今天（天）/ validity offset from today (days) */
  validInDays: number;
  terms: string;
}

/** 演示报价条款 / Demo quote terms */
export const DEMO_QUOTE_TERMS = '1. 价格含标准包装，不含运费与保险。\n2. 付款方式：30% 预付款，余款发货前付清。\n3. 交期：收到预付款后 4–6 周。\n4. 质保：整机 12 个月或 10 万公里（以先到者为准）。';

/** 虚构产品目录（美元价，另有 -CN 人民币价）/ fictional catalog (USD, plus -CN CNY variants) */
const BASE_CATALOG: [string, string, string, string, number][] = [
  ['DT-HD-11L', '重型柴油机涡轮增压器 11L（整机）', '整机增压器', '台', 980],
  ['DT-HD-13L', '重型柴油机涡轮增压器 13L（整机）', '整机增压器', '台', 1150],
  ['DT-PC-20D', '乘用车柴油机涡轮增压器 2.0L（整机）', '整机增压器', '台', 420],
  ['DT-PT-15T', '汽油机涡轮增压器 1.5T（整机）', '整机增压器', '台', 360],
  ['DT-CHRA-HD', '重卡中间体（CHRA）', '中间体', '件', 310],
  ['DT-CHRA-PC', '乘用车中间体（CHRA）', '中间体', '件', 145],
  ['DT-SW-01', '涡轮轴轮总成', '核心部件', '件', 68],
  ['DT-CW-01', '压气机轮', '核心部件', '件', 42],
  ['DT-NR-01', '可变截面喷嘴环', '核心部件', '件', 95],
  ['DT-GK-01', '涡轮增压器垫片套件', '配件', '套', 12],
  ['DT-OP-01', '增压器进回油管', '配件', '件', 18],
  ['DT-TL-BAL', '中间体动平衡检测工具', '维修工具', '套', 1650],
];
export const PRODUCT_CATALOG: ProductSeed[] = BASE_CATALOG.flatMap(([sku, name, category, unit, usd]) => [
  { sku, name: `【演示】${name}`, category, unit, unitPrice: usd.toFixed(2), currency: 'USD' as const },
  { sku: `${sku}-CN`, name: `【演示】${name}`, category, unit, unitPrice: Math.round(usd * 7.1).toFixed(2), currency: 'CNY' as const },
]);

/** 产品线 → 可用 SKU（基础 SKU，人民币商机自动用 -CN）/ product line → base SKUs */
const LINE_SKUS: Record<(typeof PRODUCTS)[number]['key'], string[]> = {
  hd: ['DT-HD-11L', 'DT-HD-13L', 'DT-GK-01'],
  pc: ['DT-PC-20D', 'DT-GK-01', 'DT-OP-01'],
  petrol: ['DT-PT-15T', 'DT-GK-01'],
  chra: ['DT-CHRA-HD', 'DT-CHRA-PC'],
  parts: ['DT-SW-01', 'DT-CW-01', 'DT-NR-01'],
  acc: ['DT-GK-01', 'DT-OP-01'],
  tools: ['DT-TL-BAL'],
};

/**
 * 生成完整演示数据集（确定性：同一种子结果相同）。
 * Generate the full demo dataset (deterministic for a given seed).
 */
export function buildDemoData(seed = 20261111) {
  const r = rng(seed);
  const between = (min: number, max: number) => Math.round(min + r() * (max - min));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

  // 商机：每个客户 1–2 个，阶段循环分布 / deals: 1–2 per account, stages spread evenly
  const deals: DealSeed[] = [];
  let stageIndex = 0;
  for (const acc of ACCOUNTS) {
    const count = acc.key === 'northlake' ? 1 : r() < 0.55 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const product = PRODUCTS.find((p) => p.key === acc.products[i % acc.products.length])!;
      const plan = STAGE_PLAN[stageIndex++ % STAGE_PLAN.length]!;
      const fx = acc.currency === 'CNY' ? 7 : acc.currency === 'EUR' ? 0.92 : 1;
      const raw = between(product.min, product.max) * fx;
      const amount = (Math.round(raw / 100) * 100).toFixed(2);
      const qualifier = pick(DEAL_QUALIFIERS);
      const short = SHORT_NAMES[acc.key] ?? acc.name.replace('【演示】', '');
      const lost = plan.stage === 'CLOSED_LOST' ? `；输单原因：${pick(LOST_REASONS)}` : '';
      deals.push({
        key: `${acc.key}-${i}`,
        account: acc.key,
        name: `【演示】${short} · ${product.short}${qualifier}`,
        amount,
        currency: acc.currency,
        stage: plan.stage,
        closeInDays: between(plan.close[0], plan.close[1]),
        owner: acc.owner,
        description: `产品线：${product.label}。区域：${acc.region}（${acc.city}）${lost}`,
        productLine: product.key,
      });
    }
  }

  // 线索 / leads
  const leads: LeadSeed[] = PROSPECTS.map(([company, region, person, owner], i) => {
    const hook = LEAD_HOOKS[i % LEAD_HOOKS.length]!;
    const slug = company.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '') || `prospect-${i + 1}`;
    return {
      name: `【演示】${person}`,
      company: `${company}（${region}）`,
      title: pick(['采购经理', '总经理', '技术主管', '品类经理', '车队维修经理', '老板']),
      owner,
      source: hook.source,
      status: LEAD_STATUS_CYCLE[i % LEAD_STATUS_CYCLE.length]!,
      email: `contact@${slug}.example`,
      phone: `+${between(1, 99)} ${between(100, 999)} 555 ${String(100 + i).padStart(4, '0')}`,
      description: hook.text,
      daysAgo: between(1, 75),
    };
  });

  // 跟进：每个商机 2–3 条、部分线索 1 条 / activities: 2–3 per deal, one for some leads
  const activities: ActivitySeed[] = [];
  const dealSteps = [
    { type: 'CALL' as const, subject: '电话沟通需求与目标车型', content: '确认适配发动机排量、年需求量与目标价格区间。' },
    { type: 'TASK' as const, subject: '寄送样品与产品目录', content: '安排样品快递并附 OE 对照表与质保说明。' },
    { type: 'MEETING' as const, subject: '视频会议：技术参数确认', content: '与客户技术团队确认流量曲线、法兰接口与执行器规格。' },
    { type: 'TASK' as const, subject: '发送正式报价单', content: '按阶梯数量报价，注明交期与付款条件。' },
    { type: 'VISIT' as const, subject: '客户来厂验厂', content: '参观装配线与质检实验室，演示动平衡与气密检测。' },
    { type: 'MEETING' as const, subject: '商务谈判：年度框架价格', content: '讨论年度返利、备货计划与付款账期。' },
    { type: 'CALL' as const, subject: '跟进付款与首批交付', content: '确认预付款到账时间与首批发货排期。' },
  ];
  for (const d of deals) {
    const n = d.stage === 'QUALIFICATION' ? 2 : 3;
    const start = { QUALIFICATION: 0, NEEDS_ANALYSIS: 1, PROPOSAL: 2, NEGOTIATION: 3, CLOSED_WON: 4, CLOSED_LOST: 3 }[d.stage];
    for (let k = 0; k < n; k++) {
      const step = dealSteps[(start + k) % dealSteps.length]!;
      const last = k === n - 1;
      const open = last && !d.stage.startsWith('CLOSED');
      activities.push({
        type: step.type,
        subject: `【演示】${step.subject}`,
        content: step.content,
        owner: d.owner,
        deal: d.key,
        account: d.account,
        daysAgo: open ? between(0, 5) : between(6, 60),
        // 未完成的最后一步：约三分之一已逾期 / open last steps: about a third overdue
        dueInDays: open ? (r() < 0.33 ? -between(1, 6) : between(1, 14)) : null,
        completed: !open,
      });
    }
  }
  leads.forEach((l, i) => {
    if (l.status === 'NEW' && i % 2 === 0) return;
    activities.push({
      type: l.source === 'EXHIBITION' ? 'MEETING' : 'CALL',
      subject: l.source === 'EXHIBITION' ? '【演示】展会洽谈记录' : '【演示】首次电话沟通',
      content: l.description,
      owner: l.owner,
      lead: i,
      daysAgo: Math.max(0, l.daysAgo - 1),
      dueInDays: l.status === 'QUALIFIED' ? between(2, 10) : null,
      completed: l.status !== 'QUALIFIED',
    });
  });

  // 备注：进行中/已结束商机各一条，部分客户一条 / notes: one per progressed deal, one for some accounts
  const DEAL_NOTES: Record<string, string[]> = {
    NEEDS_ANALYSIS: ['客户关注发动机排量与年用量，需提供适配清单。', '对方技术主管要求提供 OE 对照表和质保条款。'],
    PROPOSAL: ['已报阶梯价，客户希望首单享受试单价格。', '样品已签收，等待客户台架测试结果。'],
    NEGOTIATION: ['客户要求 60 天账期，财务建议 30% 预付款。', '竞争对手报价低约 5%，需强调交期与质保优势。'],
    CLOSED_WON: ['合同已签署，首批货预计四周内发运。', '客户确认年度框架，按季度下单。'],
    CLOSED_LOST: ['复盘：价格与交期均不占优，半年后再跟进。', '客户转向本地供应商，保持季度回访。'],
  };
  const notes: NoteSeed[] = [];
  for (const d of deals) {
    const pool = DEAL_NOTES[d.stage];
    if (pool) notes.push({ owner: d.owner, deal: d.key, content: pick(pool), daysAgo: between(1, 30) });
  }
  ACCOUNTS.forEach((acc, i) => {
    if (i % 3 === 0) notes.push({ owner: acc.owner, account: acc.key, content: `客户主营${acc.region}市场，采购决策需总经理审批。`, daysAgo: between(5, 60) });
  });

  // 产品明细：部分美元/人民币商机按产品目录生成明细，商机金额 = 明细合计
  // line items: some USD/CNY deals get items from the catalog; the deal amount equals the item total
  const items: DealItemSeed[] = [];
  deals.forEach((d, i) => {
    if (d.currency === 'EUR' || i % 3 === 2) return;
    const skus = LINE_SKUS[d.productLine];
    const count = Math.min(skus.length, between(1, 3));
    let cents = 0;
    for (const base of skus.slice(0, count)) {
      const product = PRODUCT_CATALOG.find((p) => p.sku === (d.currency === 'CNY' ? `${base}-CN` : base))!;
      const quantity = base.startsWith('DT-TL') ? between(1, 6) : between(10, 300);
      const discount = pick([0, 0, 3, 5, 8]);
      const priceCents = Math.round(Number(product.unitPrice) * 100);
      const lineCents = Math.round((quantity * priceCents * (100 - discount)) / 100);
      cents += lineCents;
      items.push({ deal: d.key, sku: product.sku, quantity: String(quantity), unitPrice: product.unitPrice, discountPercent: String(discount), lineTotal: (lineCents / 100).toFixed(2) });
    }
    d.amount = (cents / 100).toFixed(2);
  });

  // 报价单（只为带明细的商机生成）：需求分析阶段约半数有草稿；谈判阶段已发送（约三分之一已过有效期）；
  // 赢单已接受，其中每三个有一张先被拒绝的首版报价。人民币含 13% 增值税，美元出口报价不含税。
  // quotes (itemised deals only): about half of needs-analysis deals have a draft; negotiation deals have a sent quote
  // (about a third expired); won deals have an accepted quote, every third with an earlier rejected first version.
  // CNY quotes include 13% VAT; USD export quotes are tax-free.
  const quotes: QuoteSeed[] = [];
  const counters: Partial<Record<Stage, number>> = {};
  const addQuote = (d: DealSeed, status: QuoteSeed['status'], wantedDaysAgo: number, validInDays: number) => {
    // 报价单不早于商机创建 / a quote is never older than its deal
    const daysAgo = Math.min(wantedDaysAgo, dealCreatedDaysAgo(d) - 1);
    const lines = items.filter((it) => it.deal === d.key);
    const subtotalCents = lines.reduce((sum, it) => sum + Math.round(Number(it.lineTotal) * 100), 0);
    const tax = d.currency === 'CNY' ? 13 : 0;
    const taxCents = Math.round((subtotalCents * tax) / 100);
    quotes.push({
      deal: d.key,
      status,
      taxPercent: String(tax),
      subtotal: (subtotalCents / 100).toFixed(2),
      taxAmount: (taxCents / 100).toFixed(2),
      total: ((subtotalCents + taxCents) / 100).toFixed(2),
      daysAgo,
      validInDays,
      terms: DEMO_QUOTE_TERMS,
    });
  };
  for (const d of deals) {
    if (!items.some((it) => it.deal === d.key)) continue;
    const n = (counters[d.stage] = (counters[d.stage] ?? 0) + 1);
    if (d.stage === 'NEEDS_ANALYSIS' && n % 2 === 1) addQuote(d, 'DRAFT', 1 + n, 30);
    if (d.stage === 'NEGOTIATION') addQuote(d, 'SENT', 8 + 3 * n, n % 3 === 0 ? -n : 30 - n);
    if (d.stage === 'CLOSED_WON') {
      // 在成交日期前出具：被拒的首版更早 / issued before the close date; the rejected first version is older
      const closedAgo = -d.closeInDays;
      if (n % 3 === 1) addQuote(d, 'REJECTED', closedAgo + 10 + n, -closedAgo - 10);
      addQuote(d, 'ACCEPTED', closedAgo + 2 + (n % 5), 30 - closedAgo);
    }
  }

  // 已转化线索：赢单与谈判中商机各有一条来源线索（追加在末尾，不影响前面的样本）
  // converted leads: one source lead per won or negotiating deal (appended so earlier samples are unchanged)
  const CONVERTED_SOURCES: LeadSource[] = ['EXHIBITION', 'REFERRAL', 'WEBSITE', 'EXHIBITION', 'COLD_CALL'];
  deals
    .filter((d) => d.stage === 'CLOSED_WON' || d.stage === 'NEGOTIATION')
    .forEach((d, k) => {
      const acc = ACCOUNTS.find((x) => x.key === d.account)!;
      const contact = acc.contacts[0]!;
      leads.push({
        name: `【演示】${contact.name}`,
        company: acc.name,
        title: contact.title,
        owner: d.owner,
        source: CONVERTED_SOURCES[k % CONVERTED_SOURCES.length]!,
        status: 'CONVERTED',
        email: `lead${k + 1}@${acc.domain}`,
        phone: acc.phone,
        description: '来源线索，已转化为客户与商机。',
        daysAgo: dealCreatedDaysAgo(d) + 5,
        convertedDeal: d.key,
      });
    });

  return { accounts: ACCOUNTS, deals, leads, activities, notes, products: PRODUCT_CATALOG, items, quotes };
}

/** 演示标签 / Demo tags */
export const DEMO_TAGS = [
  { key: 'key', name: '重点客户', color: 'gold' },
  { key: 'strategic', name: '战略合作', color: 'green' },
  { key: 'framework', name: '年度框架', color: 'blue' },
  { key: 'price', name: '价格敏感', color: 'volcano' },
  { key: 'expo', name: '展会线索', color: 'purple' },
  { key: 'sample', name: '需要样品', color: 'cyan' },
] as const;
type DemoTagKey = (typeof DEMO_TAGS)[number]['key'];

/**
 * 演示标签的固定 ID（由组织 ID 与标签 key 推导的 UUID v5 格式）：重置后不变，保存的按标签筛选视图持续有效。
 * Stable demo tag id (UUID v5 format derived from the organization id and tag key): unchanged across resets, so
 * saved views filtering by a demo tag keep working.
 */
export function demoTagId(organizationId: string, key: string): string {
  const h = createHash('sha256').update(`yonlink-demo-tag:${organizationId}:${key}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * 演示标签分配（由数据集确定性推导）。
 * Demo tag assignments derived deterministically from the dataset.
 */
export function demoTagAssignments(data: ReturnType<typeof buildDemoData>) {
  const accounts: { account: string; tag: DemoTagKey }[] = [];
  const deals: { deal: string; tag: DemoTagKey }[] = [];
  const leads: { lead: number; tag: DemoTagKey }[] = [];
  const wonAccounts = new Set(data.deals.filter((d) => d.stage === 'CLOSED_WON').map((d) => d.account));
  data.accounts.forEach((a, i) => {
    if (wonAccounts.has(a.key) || i % 5 === 0) accounts.push({ account: a.key, tag: 'key' });
    if (i % 7 === 3) accounts.push({ account: a.key, tag: 'strategic' });
  });
  data.deals.forEach((d, i) => {
    if (d.name.includes('年度框架')) deals.push({ deal: d.key, tag: 'framework' });
    if (d.stage === 'CLOSED_LOST' || (d.stage === 'NEGOTIATION' && i % 2 === 0)) deals.push({ deal: d.key, tag: 'price' });
  });
  data.leads.forEach((l, i) => {
    if (l.source === 'EXHIBITION') leads.push({ lead: i, tag: 'expo' });
    if (l.status === 'CONTACTED' && i % 3 === 0) leads.push({ lead: i, tag: 'sample' });
  });
  return { accounts, deals, leads };
}

/** 演示附件（纯文本 / CSV，内容为虚构演示数据）/ Demo attachments (plain text / CSV, fictional content) */
export interface DemoAttachment {
  entity: 'lead' | 'account' | 'deal';
  /** 线索为序号，客户/商机为 key / lead index or account/deal key */
  ref: string | number;
  fileName: string;
  contentType: 'text/plain' | 'text/csv';
  content: string;
}

/**
 * 演示附件（由数据集确定性推导）。
 * Demo attachments derived deterministically from the dataset.
 */
export function demoAttachments(data: ReturnType<typeof buildDemoData>): DemoAttachment[] {
  const out: DemoAttachment[] = [];
  data.deals
    .filter((d) => d.stage === 'CLOSED_WON')
    .slice(0, 4)
    .forEach((d) =>
      out.push({
        entity: 'deal',
        ref: d.key,
        fileName: '合同要点（演示）.txt',
        contentType: 'text/plain',
        content: `【演示数据】${d.name}\n合同要点：\n1. 付款：30% 预付款，余款发货前付清。\n2. 交期：收到预付款后 4–6 周。\n3. 质保：整机 12 个月。\n本文件为虚构演示内容。\n`,
      }),
    );
  data.accounts.slice(0, 4).forEach((a) => {
    const rows = data.products.filter((p) => p.currency === (a.currency === 'CNY' ? 'CNY' : 'USD')).slice(0, 8);
    out.push({
      entity: 'account',
      ref: a.key,
      fileName: '产品价格表（演示）.csv',
      contentType: 'text/csv',
      content: ['SKU,产品,单位,单价,币种', ...rows.map((p) => `${p.sku},${p.name},${p.unit},${p.unitPrice},${p.currency}`)].join('\r\n') + '\r\n',
    });
  });
  data.leads
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.source === 'EXHIBITION')
    .slice(0, 3)
    .forEach(({ l, i }) =>
      out.push({
        entity: 'lead',
        ref: i,
        fileName: '展会名片记录（演示）.txt',
        contentType: 'text/plain',
        content: `【演示数据】${l.name} · ${l.company}\n展会交流要点：${l.description}\n本文件为虚构演示内容。\n`,
      }),
    );
  return out;
}

/** 演示销售目标（月度基准金额；按月份在 ±10% 内确定性浮动）/ Demo monthly targets (base amounts varied ±10% by month) */
export const DEMO_TARGETS: { owner: OwnerKey; currency: 'CNY' | 'USD'; base: number }[] = [
  { owner: 'manager', currency: 'CNY', base: 1_200_000 },
  { owner: 'sales1', currency: 'USD', base: 80_000 },
  { owner: 'sales2', currency: 'USD', base: 60_000 },
];
/** 演示目标覆盖的月份偏移（相对本月）/ month offsets covered by demo targets (relative to this month) */
export const DEMO_TARGET_MONTHS = [-5, -4, -3, -2, -1, 0, 1, 2];

/**
 * 某月的演示目标金额（两位小数字符串）。
 * Demo target amount for a month offset (2-dp string).
 */
export function demoTargetAmount(base: number, offset: number): string {
  return (base * (1 + (((offset % 3) + 3) % 3 - 1) * 0.1)).toFixed(2);
}

/**
 * 演示用的重复记录（展示查重合并）：在原始数据之后单独写入，不影响其他样本。
 * - 线索 A：与第 11 条线索邮箱相同（大小写不同）、电话格式不同；
 * - 线索 B：与第 8 条线索姓名、公司相同；
 * - 客户：名称只差空格与标点、网站域名相同（带路径）。
 * Demo duplicates (to show deduplication), written after the main data so other samples are unaffected.
 */
export function demoDuplicates(data: ReturnType<typeof buildDemoData>) {
  // 源记录不能是 E2E 使用的样本（否则按名称搜索会出现两行）/ sources must not be E2E samples (name searches would match twice)
  const l1 = data.leads[10]!;
  const l2 = data.leads[7]!;
  const samples = new Set(Object.values(demoSamples()));
  if (samples.has(l1.name) || samples.has(l2.name)) throw new Error('demo duplicates must not copy E2E sample leads');
  const acc = data.accounts[2]!;
  return {
    leads: [
      { ...l1, email: l1.email.toUpperCase(), phone: l1.phone.replace(/ /g, '-'), description: '重复录入：同一联系人在官网再次留资。', daysAgo: 2, convertedDeal: undefined },
      { ...l2, email: `sales.${l2.email}`, phone: l2.phone.replace(/\d{2}$/, '99'), description: '重复录入：展会名片再次录入。', daysAgo: 1, convertedDeal: undefined },
    ],
    accounts: [{ of: acc.key, name: `${acc.name.replace('】', '】 ')} `, website: `http://${acc.domain}/contact-us`, phone: acc.phone.replace(/ /g, '') }],
  };
}

/** 演示销售订单 / Demo sales order */
export interface DemoOrder {
  /** 来源报价单所属商机（每个商机至多一张已接受报价单）/ deal of the source quote (at most one accepted quote per deal) */
  deal: string;
  status: 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
  /** 创建于几天前 / created N days ago */
  daysAgo: number;
  /** 预计交付日期相对今天（天）/ expected delivery offset from today (days) */
  expectedInDays: number;
  cancelReason?: string;
}

/**
 * 演示销售订单：每张已接受的报价单在接受次日生成订单；最新一张已确认、次新一张已发货、其余已交付，
 * 每 7 张中有 1 张已取消（取消后报价单可再次生成订单）。
 * Demo sales orders: one per accepted quote, created the day after acceptance; the newest is confirmed, the next
 * shipped and the rest delivered; one in seven is cancelled (the quote can then be ordered again).
 */
export function demoOrders(data: ReturnType<typeof buildDemoData>): DemoOrder[] {
  const accepted = data.quotes.filter((q) => q.status === 'ACCEPTED').sort((a, b) => b.daysAgo - a.daysAgo);
  return accepted.map((q, k) => {
    // 报价单在创建 5 天后被接受，订单在接受次日生成 / quotes are accepted 5 days after creation; orders follow a day later
    const daysAgo = Math.max(0, q.daysAgo - 6);
    const fromNewest = accepted.length - 1 - k;
    let status: DemoOrder['status'] = fromNewest === 0 ? 'CONFIRMED' : fromNewest === 1 ? 'SHIPPED' : 'DELIVERED';
    if (k % 7 === 3) status = 'CANCELLED';
    return {
      deal: q.deal,
      status,
      daysAgo,
      expectedInDays: 15 - daysAgo,
      cancelReason: status === 'CANCELLED' ? '客户调整采购计划，改为下季度重新下单。' : undefined,
    };
  });
}

/** 演示发票 / Demo invoice */
export interface DemoInvoice {
  /** 来源订单所属商机 / deal of the source order */
  deal: string;
  /** 开票于几天前 / invoiced N days ago */
  daysAgo: number;
  /** 付款期限（天）/ payment term (days) */
  termDays: number;
  /** 收款：占总计的比例与开票后第几天；最后一笔按余额补齐 / payments: share of the total and days after invoicing; the last one settles the rest when shares sum to 1 */
  payments: { share: number; afterDays: number; method: 'BANK_TRANSFER' | 'CHECK' | 'CASH'; reference: string }[];
}

/**
 * 演示发票：为已发货、已交付的订单各开一张（开票于订单生成 6 天后，付款期限 30 天），从早到晚依次为
 * 一次付清、分两次付清、部分付款（逾期）、未付款（逾期）、未付款（未到期）。
 * Demo invoices: one per shipped or delivered order (invoiced 6 days after the order, 30-day term); from oldest to
 * newest: paid in one go, paid in two instalments, partially paid (overdue), unpaid (overdue), unpaid (not yet due).
 */
export function demoInvoices(data: ReturnType<typeof buildDemoData>): DemoInvoice[] {
  const PLANS: DemoInvoice['payments'][] = [
    [{ share: 1, afterDays: 25, method: 'BANK_TRANSFER', reference: 'TT-DEMO-001' }],
    [
      { share: 0.5, afterDays: 18, method: 'BANK_TRANSFER', reference: 'TT-DEMO-002' },
      { share: 0.5, afterDays: 38, method: 'CHECK', reference: 'CHK-DEMO-003' },
    ],
    [{ share: 0.3, afterDays: 23, method: 'BANK_TRANSFER', reference: 'TT-DEMO-004' }],
    [],
    [],
  ];
  return demoOrders(data)
    .filter((o) => o.status === 'SHIPPED' || o.status === 'DELIVERED')
    .map((o, k) => ({ deal: o.deal, daysAgo: Math.max(0, o.daysAgo - 6), termDays: 30, payments: PLANS[k] ?? [] }));
}

/** 演示通知 / Demo notification */
export interface DemoNotification {
  to: OwnerKey;
  from: 'admin' | 'manager';
  target: { lead: number } | { account: string } | { deal: string };
  title: string;
  hoursAgo: number;
  read: boolean;
}

/**
 * 演示通知：经理把记录分配给两位销售、管理员分配给经理，每人一条线索、一个进行中的商机（未读）和一个客户（已读）；
 * 目标记录均由接收人负责。跟进到期提醒由系统按真实到期时间自动生成，不预置。
 * Demo notifications: the manager assigns records to both sales reps and the admin to the manager, one lead and one
 * open deal (unread) and one account (read) each, all owned by the recipient. Activity reminders are generated by
 * the system from real due times and are not seeded.
 */
export function demoNotifications(data: ReturnType<typeof buildDemoData>): DemoNotification[] {
  const recipients = [
    { to: 'sales1', from: 'manager' },
    { to: 'sales2', from: 'manager' },
    { to: 'manager', from: 'admin' },
  ] as const;
  return recipients.flatMap(({ to, from }) => {
    const lead = data.leads.findIndex((l) => l.owner === to && l.status !== 'CONVERTED');
    const deal = data.deals.find((d) => d.owner === to && !d.stage.startsWith('CLOSED'))!;
    const account = data.accounts.find((a) => a.owner === to)!;
    return [
      { to, from, target: { lead }, title: data.leads[lead]!.name, hoursAgo: 2, read: false },
      { to, from, target: { deal: deal.key }, title: deal.name, hoursAgo: 26, read: false },
      { to, from, target: { account: account.key }, title: account.name, hoursAgo: 72, read: true },
    ];
  });
}

/**
 * E2E 测试使用的样本（由数据集推导，数据调整后测试自动跟随）。
 * Samples used by the E2E tests (derived from the dataset so tests follow data changes).
 */
export function demoSamples() {
  const { deals, leads } = buildDemoData();
  const firstLead = (owner: OwnerKey) => leads.find((l) => l.owner === owner)!.name;
  const firstDeal = (owner: OwnerKey) => deals.find((d) => d.owner === owner)!.name;
  return {
    sales1Lead: firstLead('sales1'),
    sales2Lead: firstLead('sales2'),
    managerLead: firstLead('manager'),
    /** 王芳负责、且只有 1 个商机的客户 / a 王芳 account with exactly one deal */
    sales1SingleDealAccount: ACCOUNTS.find((a) => a.key === 'northlake')!.name,
    sales1Deal: firstDeal('sales1'),
    sales2Deal: firstDeal('sales2'),
  };
}
