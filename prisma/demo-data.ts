/**
 * 演示数据（纯数据，无数据库依赖）：虚构的涡轮增压器售后市场企业。
 * 产品线与销售场景参考公开的行业信息（整机增压器、中间体/CHRA、核心部件、配件、维修工具；AAPEX / SEMA / 上海法兰克福汽配展），
 * 所有公司、客户、联系人均为虚构，名称带【演示】；网站使用保留域名 .example，电话使用 555 保留号段。
 * Demo data (pure data, no DB access): a fictional turbocharger-aftermarket company. Product lines and sales
 * scenarios follow public industry information; every company, customer and contact is fictional and labelled
 * 【演示】; websites use the reserved .example TLD and phone numbers the reserved 555 range.
 */

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
  { stage: 'CLOSED_WON', close: [-90, -3] },
  { stage: 'CLOSED_LOST', close: [-120, -10] },
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

  return { accounts: ACCOUNTS, deals, leads, activities, notes };
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
