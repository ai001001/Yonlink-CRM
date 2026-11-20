/**
 * 应用外壳：左侧导航（分组可折叠，支持收起侧栏、全部收起、全部展开，底部显示咨询方式）、顶部栏、登录守卫。
 * App shell: side navigation (collapsible groups, collapse sidebar / collapse all / expand all, contact details at the
 * bottom), header and auth guard.
 */
'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Avatar, Button, Dropdown, Grid, Layout, Menu, Spin, Tag, Tooltip, Typography, type MenuProps } from 'antd';
import {
  AccountBookOutlined,
  AimOutlined,
  ApiOutlined,
  AppstoreOutlined,
  AuditOutlined,
  BankOutlined,
  BarChartOutlined,
  BlockOutlined,
  ContactsOutlined,
  CustomerServiceOutlined,
  DashboardOutlined,
  DeleteOutlined,
  DollarOutlined,
  FileTextOutlined,
  FormOutlined,
  FundOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  NotificationOutlined,
  ReadOutlined,
  RiseOutlined,
  ScheduleOutlined,
  SettingOutlined,
  ShopOutlined,
  ShoppingCartOutlined,
  ShoppingOutlined,
  TagsOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserAddOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { t, tEnum } from '@/i18n';
import { useAuth } from './AuthProvider';
import { ContactInfo } from './ContactInfo';
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
const NAV_GROUPS: { key: string; label: string | null; icon?: React.ReactNode; items: NavItem[] }[] = [
  { key: 'home', label: null, items: [{ key: '/', icon: <DashboardOutlined />, label: t('nav.dashboard') }] },
  {
    key: 'sales',
    label: t('nav.group.sales'),
    icon: <RiseOutlined />,
    items: [
      { key: '/leads', icon: <UserAddOutlined />, label: t('nav.leads') },
      { key: '/contacts', icon: <ContactsOutlined />, label: t('nav.contacts') },
      { key: '/accounts', icon: <BankOutlined />, label: t('nav.accounts') },
      { key: '/deals', icon: <FundOutlined />, label: t('nav.deals') },
      { key: '/forecasts', icon: <AimOutlined />, label: t('nav.forecasts') },
    ],
  },
  {
    key: 'marketing',
    label: t('nav.group.marketing'),
    icon: <NotificationOutlined />,
    items: [
      { key: '/campaigns', icon: <NotificationOutlined />, label: t('nav.campaigns') },
      { key: '/web-forms', icon: <FormOutlined />, label: t('nav.webForms') },
    ],
  },
  {
    key: 'activities',
    label: t('nav.group.activities'),
    icon: <ScheduleOutlined />,
    items: [
      { key: '/activities', icon: <ScheduleOutlined />, label: t('nav.activities') },
      { key: '/approvals', icon: <AuditOutlined />, label: t('nav.approvals') },
    ],
  },
  {
    key: 'inventory',
    label: t('nav.group.inventory'),
    icon: <AppstoreOutlined />,
    items: [
      { key: '/products', icon: <AppstoreOutlined />, label: t('nav.products') },
      { key: '/price-books', icon: <TagsOutlined />, label: t('nav.priceBooks') },
      { key: '/quotes', icon: <FileTextOutlined />, label: t('nav.quotes') },
      { key: '/sales-orders', icon: <ShoppingCartOutlined />, label: t('nav.salesOrders') },
      { key: '/purchase-orders', icon: <ShoppingOutlined />, label: t('nav.purchaseOrders'), permission: 'purchase.read' },
      { key: '/invoices', icon: <AccountBookOutlined />, label: t('nav.invoices') },
      { key: '/vendors', icon: <ShopOutlined />, label: t('nav.vendors'), permission: 'purchase.read' },
    ],
  },
  {
    key: 'support',
    label: t('nav.group.support'),
    icon: <CustomerServiceOutlined />,
    items: [
      { key: '/tickets', icon: <CustomerServiceOutlined />, label: t('nav.tickets') },
      { key: '/kb', icon: <ReadOutlined />, label: t('nav.kb') },
    ],
  },
  { key: 'analytics', label: t('nav.group.analytics'), icon: <BarChartOutlined />, items: [{ key: '/reports', icon: <BarChartOutlined />, label: t('nav.reports') }] },
  {
    key: 'setup',
    label: t('nav.group.setup'),
    icon: <SettingOutlined />,
    items: [
      { key: '/users', icon: <TeamOutlined />, label: t('nav.users'), permission: 'user.manage' },
      { key: '/workflows', icon: <ThunderboltOutlined />, label: t('nav.workflows'), permission: 'workflow.manage' },
      { key: '/integrations', icon: <ApiOutlined />, label: t('nav.integrations'), permission: 'integration.manage' },
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
    return g.label ? [{ key: g.key, icon: g.icon, label: g.label, children: items }] : items;
  });
}

/** 可折叠分组的键 / keys of the collapsible groups */
const GROUP_KEYS = NAV_GROUPS.filter((g) => g.label).map((g) => g.key);

/**
 * 菜单项所属分组。
 * Group of a menu entry.
 */
function groupOf(key: string): string | undefined {
  return NAV_GROUPS.find((g) => g.label && g.items.some((n) => n.key === key))?.key;
}

/** 侧栏状态的本地保存键（仅本浏览器）/ local storage key for the sidebar state (this browser only) */
const NAV_STATE_KEY = 'yonlink.nav.v1';

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
  const screens = Grid.useBreakpoint();
  // 默认全部展开；收起状态与展开的分组保存在本浏览器 / all groups open by default; state kept in this browser
  const [collapsed, setCollapsed] = useState(false);
  // 用户自己选择的收起状态（窄屏时会被临时覆盖，回到宽屏时恢复）/ the user's own choice (overridden on narrow screens, restored on wide ones)
  const [preferCollapsed, setPreferCollapsed] = useState(false);
  const [openKeys, setOpenKeys] = useState<string[]>(GROUP_KEYS);
  const current = selectedKey(pathname);

  useEffect(() => {
    if (!loading && !me) router.replace('/login');
  }, [loading, me, router]);

  // 读取保存的侧栏状态（读写失败时使用默认值）/ restore the saved sidebar state (defaults when storage fails)
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(NAV_STATE_KEY) ?? 'null') as { collapsed?: boolean; openKeys?: string[] } | null;
      if (saved) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPreferCollapsed(!!saved.collapsed);
        setCollapsed(!!saved.collapsed);
        if (Array.isArray(saved.openKeys)) setOpenKeys(saved.openKeys.filter((k) => GROUP_KEYS.includes(k)));
      }
    } catch {
      // 存储不可用时忽略 / ignore unavailable storage
    }
  }, []);

  const persist = useCallback((next: { collapsed: boolean; openKeys: string[] }) => {
    try {
      localStorage.setItem(NAV_STATE_KEY, JSON.stringify(next));
    } catch {
      // 存储不可用时忽略 / ignore unavailable storage
    }
  }, []);

  // 打开某页时自动展开其所在分组 / opening a page expands its group
  useEffect(() => {
    const g = groupOf(current);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (g) setOpenKeys((keys) => (keys.includes(g) ? keys : [...keys, g]));
  }, [current]);

  const changeOpen = (keys: string[]) => {
    setOpenKeys(keys);
    persist({ collapsed, openKeys: keys });
  };
  const toggleSider = () => {
    setPreferCollapsed(!collapsed);
    setCollapsed(!collapsed);
    persist({ collapsed: !collapsed, openKeys });
  };
  // 全部收起时保留当前页面所在分组 / collapse all keeps the current page's group open
  const collapseAll = () => changeOpen([groupOf(current)].filter((k): k is string => !!k));
  const expandAll = () => changeOpen(GROUP_KEYS);

  if (loading || !me) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spin />
      </div>
    );
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider
        width={208}
        collapsedWidth={64}
        theme="dark"
        breakpoint="lg"
        collapsed={collapsed}
        // 窄屏自动收起；回到宽屏恢复用户自己的选择（加载时也会触发一次）/ narrow screens collapse; wide ones restore the user's choice (also fires on load)
        onBreakpoint={(broken) => setCollapsed(broken || preferCollapsed)}
        trigger={null}
        data-testid="sider"
        style={{ position: 'sticky', top: 0, height: '100vh', overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div style={{ color: '#fff', padding: collapsed ? '18px 0' : '18px 20px 8px', fontSize: 18, fontWeight: 600, textAlign: collapsed ? 'center' : undefined }}>
            {collapsed ? t('app.name').slice(0, 1) : t('app.name')}
            {!collapsed && <div style={{ fontSize: 12, fontWeight: 400, opacity: 0.65 }}>{t('app.brand')}</div>}
          </div>
          {collapsed ? (
            <Tooltip placement="right" title={t('nav.expandSider')}>
              <Button type="text" icon={<MenuUnfoldOutlined />} onClick={toggleSider} aria-label={t('nav.expandSider')} style={{ color: 'rgba(255,255,255,0.75)', margin: '0 auto 8px' }} />
            </Tooltip>
          ) : (
            <div data-testid="sider-toolbar" style={{ display: 'flex', justifyContent: 'space-between', padding: '0 12px 8px' }}>
              {(
                [
                  ['nav.collapseSider', toggleSider],
                  ['nav.collapseAll', collapseAll],
                  ['nav.expandAll', expandAll],
                ] as const
              ).map(([key, onClick]) => (
                <Button key={key} type="link" size="small" onClick={onClick} style={{ color: 'rgba(255,255,255,0.75)', padding: '0 4px', fontSize: 12 }}>
                  {key === 'nav.collapseSider' ? `« ${t(key)}` : t(key)}
                </Button>
              ))}
            </div>
          )}
          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
            <Menu
              theme="dark"
              mode="inline"
              selectedKeys={[current]}
              // 收起侧栏时由菜单自行以弹出方式显示分组 / when collapsed the menu shows groups as pop-ups
              {...(collapsed ? {} : { openKeys, onOpenChange: changeOpen })}
              items={menuItems(me.permissions)}
            />
          </div>
          {collapsed ? (
            <div style={{ textAlign: 'center', padding: '8px 0 12px' }}>
              <ContactInfo variant="icon" />
            </div>
          ) : (
            <ContactInfo variant="block" />
          )}
        </div>
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{ background: '#fff', padding: '0 24px', display: 'flex', alignItems: 'center', gap: 16, borderBottom: '1px solid #e8ecf2' }}
        >
          <Tooltip title={t(collapsed ? 'nav.expandSider' : 'nav.collapseSider')}>
            <Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={toggleSider} aria-label={t(collapsed ? 'nav.expandSider' : 'nav.collapseSider')} data-testid="sider-toggle" />
          </Tooltip>
          <GlobalSearch />
          {screens.xl && <ContactInfo variant="pill" />}
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
