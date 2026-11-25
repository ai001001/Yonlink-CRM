/**
 * 应用外壳：左侧导航（分组可折叠，支持收起侧栏、全部收起、全部展开，底部显示咨询方式）、顶部栏、登录守卫。
 * App shell: side navigation (collapsible groups, collapse sidebar / collapse all / expand all, contact details at the
 * bottom), header and auth guard.
 */
'use client';

import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Avatar, Button, Drawer, Dropdown, Grid, Layout, Menu, Spin, Tag, Tooltip, Typography, type MenuProps } from 'antd';
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
  SafetyOutlined,
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
  GlobalOutlined,
  PlayCircleOutlined,
  ApartmentOutlined,
  ProfileOutlined,
  MenuOutlined,
  EllipsisOutlined,
} from '@ant-design/icons';
import { t, tEnum } from '@/i18n';
import { api } from '@/lib/api';
import { MODULES_CHANGED, type CustomModule } from '@/lib/modules';
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
  // 自定义模块：菜单项按启用的模块动态生成 / custom modules: entries come from the active modules at run time
  { key: 'modules', label: t('nav.group.modules'), icon: <ProfileOutlined />, items: [] },
  { key: 'analytics', label: t('nav.group.analytics'), icon: <BarChartOutlined />, items: [{ key: '/reports', icon: <BarChartOutlined />, label: t('nav.reports') }] },
  {
    key: 'setup',
    label: t('nav.group.setup'),
    icon: <SettingOutlined />,
    items: [
      { key: '/users', icon: <TeamOutlined />, label: t('nav.users'), permission: 'user.manage' },
      { key: '/workflows', icon: <ThunderboltOutlined />, label: t('nav.workflows'), permission: 'workflow.manage' },
      { key: '/validation-rules', icon: <SafetyOutlined />, label: t('nav.validationRules'), permission: 'validation.manage' },
      { key: '/custom-fields', icon: <FormOutlined />, label: t('nav.customFields'), permission: 'customfield.manage' },
      { key: '/custom-modules', icon: <ProfileOutlined />, label: t('nav.customModules'), permission: 'customfield.manage' },
      { key: '/territories', icon: <GlobalOutlined />, label: t('nav.territories'), permission: 'territory.manage' },
      { key: '/blueprints', icon: <ApartmentOutlined />, label: t('nav.blueprints'), permission: 'blueprint.manage' },
      { key: '/cadences', icon: <ScheduleOutlined />, label: t('nav.cadences'), permission: 'cadence.manage' },
      { key: '/portal-settings', icon: <GlobalOutlined />, label: t('nav.portal'), permission: 'portal.manage' },
      { key: '/macros', icon: <PlayCircleOutlined />, label: t('nav.macros'), permission: 'record.update.own' },
      { key: '/integrations', icon: <ApiOutlined />, label: t('nav.integrations'), permission: 'integration.manage' },
      { key: '/exchange-rates', icon: <DollarOutlined />, label: t('nav.rates') },
      { key: '/duplicates', icon: <BlockOutlined />, label: t('nav.duplicates') },
      { key: '/recycle-bin', icon: <DeleteOutlined />, label: t('nav.recycleBin'), permission: 'record.delete' },
      { key: '/audit-logs', icon: <AuditOutlined />, label: t('nav.audit'), permission: 'audit.read' },
    ],
  },
];

/** 自定义模块菜单项的键前缀 / key prefix of custom module entries */
const MODULE_PREFIX = '/modules?m=';
/** 自定义模块菜单项的键（即链接地址）/ key (the link) of a custom module entry */
const moduleKey = (id: string) => `${MODULE_PREFIX}${id}`;

/** 全部菜单项（用于高亮判断）/ every entry (for highlighting) */
const NAV = NAV_GROUPS.flatMap((g) => g.items);

/**
 * 当前用户可见的菜单（antd 分组格式）。
 * Menu items visible to the user (antd group format).
 */
function menuItems(permissions: string[], modules: CustomModule[]): MenuProps['items'] {
  return NAV_GROUPS.flatMap((g): NonNullable<MenuProps['items']> => {
    const items = (g.key === 'modules' ? modules.map((m) => ({ key: moduleKey(m.id), icon: <ProfileOutlined />, label: m.name })) : g.items)
      .filter((n) => !('permission' in n) || !n.permission || permissions.includes(n.permission))
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
  if (key.startsWith(MODULE_PREFIX)) return 'modules';
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

/**
 * 读取地址中的自定义模块 ID（useSearchParams 需在 Suspense 内）。
 * Report the custom module id from the URL (useSearchParams must sit inside Suspense).
 */
function ModuleParam({ onChange }: { onChange: (id: string | null) => void }) {
  const m = useSearchParams().get('m');
  useEffect(() => onChange(m), [m, onChange]);
  return null;
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
  // 自定义模块（启用的）与当前模块 ID / active custom modules and the current module id
  const [modules, setModules] = useState<CustomModule[]>([]);
  const [moduleParam, setModuleParam] = useState<string | null>(null);
  const onModulesPage = (pathname.replace(/\/$/, '') || '/') === '/modules';
  const current = onModulesPage && moduleParam ? moduleKey(moduleParam) : selectedKey(pathname);

  const loadModules = useCallback(() => {
    api<{ items: CustomModule[] }>('/api/custom-modules?active=true')
      .then((r) => setModules(r.items))
      .catch(() => setModules([]));
  }, []);
  useEffect(() => {
    if (me) loadModules();
    window.addEventListener(MODULES_CHANGED, loadModules);
    return () => window.removeEventListener(MODULES_CHANGED, loadModules);
  }, [me, loadModules]);

  // 手机（宽度 < 768px）：侧栏改为抽屉菜单，底部显示常用入口 / phones (< 768px): the sider becomes a drawer, with a bottom tab bar
  const mobile = screens.md === false;
  const [menuOpen, setMenuOpen] = useState(false);
  // 换页后关闭抽屉菜单 / close the drawer menu after navigating
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMenuOpen(false);
  }, [pathname, moduleParam]);

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

  // 头像菜单（个人设置、退出）/ avatar menu (profile, sign out)
  const userMenu = (
    <Dropdown
      // 触屏没有悬停，手机上点击展开 / touch screens have no hover, so phones open it on tap
      trigger={mobile ? ['click'] : ['hover']}
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
      <span style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }} data-testid="user-menu" aria-label={me.name}>
        <Avatar style={{ background: '#1f5fbf' }}>{me.name.slice(0, 1)}</Avatar>
        {!mobile && me.name}
      </span>
    </Dropdown>
  );

  if (mobile) {
    // 手机布局：顶部栏（菜单、搜索、通知、头像）、抽屉菜单（品牌、组织与角色、语言、完整导航、咨询方式）、底部常用入口
    // phone layout: header (menu, search, bell, avatar), drawer menu (brand, organization and role, language, full
    // navigation, contact details) and a bottom tab bar
    const tabs: { key: string; icon: ReactNode; label: string }[] = [
      { key: '/', icon: <DashboardOutlined />, label: t('nav.dashboard') },
      { key: '/accounts', icon: <BankOutlined />, label: t('nav.accounts') },
      { key: '/deals', icon: <FundOutlined />, label: t('nav.deals') },
      { key: '/activities', icon: <ScheduleOutlined />, label: t('nav.activities') },
    ];
    return (
      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Header
          style={{ background: '#fff', padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4, borderBottom: '1px solid #e8ecf2', position: 'sticky', top: 0, zIndex: 100, height: 56, lineHeight: '56px' }}
        >
          <Button type="text" icon={<MenuOutlined />} onClick={() => setMenuOpen(true)} aria-label={t('nav.openMenu')} data-testid="mobile-menu-toggle" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <GlobalSearch />
          </div>
          <NotificationBell />
          {userMenu}
        </Layout.Header>
        <Drawer
          placement="left"
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          size={280}
          closable={false}
          data-testid="mobile-menu"
          styles={{ body: { padding: 0, background: '#001529', display: 'flex', flexDirection: 'column' } }}
        >
          <div style={{ color: '#fff', padding: '16px 20px 8px', fontSize: 18, fontWeight: 600 }}>
            {t('app.name')}
            <div style={{ fontSize: 12, fontWeight: 400, opacity: 0.65 }}>{me.organization.name}</div>
            <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
              {me.isDemo && <Tag color="orange">{t('demo.badge')}</Tag>}
              <Tag color="blue" data-testid="current-role">
                {tEnum('role', me.role)}
              </Tag>
              <LanguageSwitch />
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <Menu theme="dark" mode="inline" selectedKeys={[current]} openKeys={openKeys} onOpenChange={changeOpen} items={menuItems(me.permissions, modules)} onClick={() => setMenuOpen(false)} />
          </div>
          <ContactInfo variant="block" />
        </Drawer>
        <Suspense>
          <ModuleParam onChange={setModuleParam} />
        </Suspense>
        {/* 底部留出常用入口栏的高度（含全面屏底部安全区）/ leave room for the tab bar (and the home-indicator safe area) */}
        <Layout.Content style={{ padding: 12, paddingBottom: 'calc(72px + env(safe-area-inset-bottom))' }}>{children}</Layout.Content>
        <nav className="mobile-tabbar" data-testid="mobile-tabbar" aria-label={t('nav.tabbar')}>
          {tabs.map((tab) => (
            <Link key={tab.key} href={tab.key} className={current === tab.key ? 'active' : undefined} aria-current={current === tab.key ? 'page' : undefined}>
              {tab.icon}
              <span>{tab.label}</span>
            </Link>
          ))}
          <button type="button" onClick={() => setMenuOpen(true)} data-testid="mobile-more">
            <EllipsisOutlined />
            <span>{t('nav.more')}</span>
          </button>
        </nav>
      </Layout>
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
              items={menuItems(me.permissions, modules)}
            />
            <Suspense>
              <ModuleParam onChange={setModuleParam} />
            </Suspense>
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
          {userMenu}
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>{children}</Layout.Content>
      </Layout>
    </Layout>
  );
}
