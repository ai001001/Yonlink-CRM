/**
 * 应用外壳：左侧导航、顶部栏、登录守卫。
 * App shell: side navigation, header and auth guard.
 */
'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Avatar, Dropdown, Layout, Menu, Spin, Tag, Typography, type MenuProps } from 'antd';
import {
  BankOutlined,
  BarChartOutlined,
  BlockOutlined,
  ContactsOutlined,
  CustomerServiceOutlined,
  ReadOutlined,
  DashboardOutlined,
  DollarOutlined,
  DeleteOutlined,
  FileTextOutlined,
  FundOutlined,
  LogoutOutlined,
  AimOutlined,
  NotificationOutlined,
  AppstoreOutlined,
  AuditOutlined,
  AccountBookOutlined,
  ScheduleOutlined,
  ShoppingCartOutlined,
  TeamOutlined,
  UserAddOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { t, tEnum } from '@/i18n';
import { useAuth } from './AuthProvider';
import { GlobalSearch } from './GlobalSearch';
import { LanguageSwitch } from './LanguageSwitch';
import { NotificationBell } from './NotificationBell';

/** 菜单项 / Menu entry */
interface NavItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  /** 需要的权限（缺省所有人可见）/ permission required (everyone when absent) */
  permission?: string;
}

/**
 * 导航结构（参考 Zoho CRM 的模块分组）：首页；销售、营销、活动、库存、服务、分析；设置（系统管理，按权限显示）。
 * 通知不占导航位置，从顶部铃铛进入；个人设置在右上角用户菜单中。分组下没有可见项时整组隐藏。
 * Navigation grouped like Zoho CRM modules: home; sales, marketing, activities, inventory, support, analytics;
 * setup (administration, shown by permission). Notifications live under the bell and the profile under the user
 * menu. A group with no visible entries is hidden.
 */
const NAV_GROUPS: { key: string; label: string | null; items: NavItem[] }[] = [
  { key: 'home', label: null, items: [{ key: '/', icon: <DashboardOutlined />, label: t('nav.dashboard') }] },
  {
    key: 'sales',
    label: t('nav.group.sales'),
    items: [
      { key: '/leads', icon: <UserAddOutlined />, label: t('nav.leads') },
      { key: '/contacts', icon: <ContactsOutlined />, label: t('nav.contacts') },
      { key: '/accounts', icon: <BankOutlined />, label: t('nav.accounts') },
      { key: '/deals', icon: <FundOutlined />, label: t('nav.deals') },
      { key: '/forecasts', icon: <AimOutlined />, label: t('nav.forecasts') },
    ],
  },
  { key: 'marketing', label: t('nav.group.marketing'), items: [{ key: '/campaigns', icon: <NotificationOutlined />, label: t('nav.campaigns') }] },
  { key: 'activities', label: t('nav.group.activities'), items: [{ key: '/activities', icon: <ScheduleOutlined />, label: t('nav.activities') }] },
  {
    key: 'inventory',
    label: t('nav.group.inventory'),
    items: [
      { key: '/products', icon: <AppstoreOutlined />, label: t('nav.products') },
      { key: '/quotes', icon: <FileTextOutlined />, label: t('nav.quotes') },
      { key: '/sales-orders', icon: <ShoppingCartOutlined />, label: t('nav.salesOrders') },
      { key: '/invoices', icon: <AccountBookOutlined />, label: t('nav.invoices') },
    ],
  },
  {
    key: 'support',
    label: t('nav.group.support'),
    items: [
      { key: '/tickets', icon: <CustomerServiceOutlined />, label: t('nav.tickets') },
      { key: '/kb', icon: <ReadOutlined />, label: t('nav.kb') },
    ],
  },
  { key: 'analytics', label: t('nav.group.analytics'), items: [{ key: '/reports', icon: <BarChartOutlined />, label: t('nav.reports') }] },
  {
    key: 'setup',
    label: t('nav.group.setup'),
    items: [
      { key: '/users', icon: <TeamOutlined />, label: t('nav.users'), permission: 'user.manage' },
      { key: '/exchange-rates', icon: <DollarOutlined />, label: t('nav.rates') },
      { key: '/duplicates', icon: <BlockOutlined />, label: t('nav.duplicates') },
      { key: '/recycle-bin', icon: <DeleteOutlined />, label: t('nav.recycleBin'), permission: 'record.delete' },
      { key: '/audit-logs', icon: <AuditOutlined />, label: t('nav.audit'), permission: 'audit.read' },
    ],
  },
];

/** 全部菜单项（用于高亮判断）/ every entry (for highlighting) */
const NAV = NAV_GROUPS.flatMap((g) => g.items);

/**
 * 当前用户可见的菜单（antd 分组格式）。
 * Menu items visible to the user (antd group format).
 */
function menuItems(permissions: string[]): MenuProps['items'] {
  return NAV_GROUPS.flatMap((g): NonNullable<MenuProps['items']> => {
    const items = g.items
      .filter((n) => !n.permission || permissions.includes(n.permission))
      .map((n) => ({ key: n.key, icon: n.icon, label: <Link href={n.key}>{n.label}</Link> }));
    if (!items.length) return [];
    return g.label ? [{ type: 'group' as const, key: `group-${g.key}`, label: g.label, children: items }] : items;
  });
}

/**
 * 根据路径计算当前菜单项。
 * Resolve the selected menu key from the path.
 */
function selectedKey(pathname: string): string {
  const path = pathname.replace(/\/$/, '') || '/';
  if (path === '/') return '/';
  // 不在导航中的页面（如个人设置）不高亮任何项 / pages outside the navigation (e.g. the profile) highlight nothing
  return NAV.find((n) => n.key !== '/' && path.startsWith(n.key))?.key ?? '';
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, loading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !me) router.replace('/login');
  }, [loading, me, router]);

  if (loading || !me) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spin />
      </div>
    );
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider width={208} theme="dark" breakpoint="lg">
        <div style={{ color: '#fff', padding: '18px 20px', fontSize: 18, fontWeight: 600 }}>
          {t('app.name')}
          <div style={{ fontSize: 12, fontWeight: 400, opacity: 0.65 }}>{t('app.brand')}</div>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey(pathname)]}
          items={menuItems(me.permissions)}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{ background: '#fff', padding: '0 24px', display: 'flex', alignItems: 'center', gap: 16, borderBottom: '1px solid #e8ecf2' }}
        >
          <GlobalSearch />
          <div style={{ flex: 1 }} />
          <NotificationBell />
          <LanguageSwitch />
          <Typography.Text type="secondary">{me.organization.name}</Typography.Text>
          {me.isDemo && <Tag color="orange">{t('demo.badge')}</Tag>}
          <Tag color="blue" data-testid="current-role">
            {tEnum('role', me.role)}
          </Tag>
          <Dropdown
            menu={{
              items: [
                { key: 'profile', icon: <UserOutlined />, label: t('nav.profile') },
                { key: 'logout', icon: <LogoutOutlined />, label: t('nav.logout') },
              ],
              onClick: async ({ key }) => {
                if (key === 'profile') {
                  router.push('/profile');
                  return;
                }
                await signOut();
                router.replace('/login');
              },
            }}
          >
            <span style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }} data-testid="user-menu">
              <Avatar style={{ background: '#1f5fbf' }}>{me.name.slice(0, 1)}</Avatar>
              {me.name}
            </span>
          </Dropdown>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>{children}</Layout.Content>
      </Layout>
    </Layout>
  );
}
