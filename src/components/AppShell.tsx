/**
 * 应用外壳：左侧导航、顶部栏、登录守卫。
 * App shell: side navigation, header and auth guard.
 */
'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Avatar, Dropdown, Layout, Menu, Spin, Tag, Typography } from 'antd';
import {
  BankOutlined,
  DashboardOutlined,
  FundOutlined,
  LogoutOutlined,
  AppstoreOutlined,
  AuditOutlined,
  ScheduleOutlined,
  TeamOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import { t, tEnum } from '@/i18n';
import { useAuth } from './AuthProvider';
import { GlobalSearch } from './GlobalSearch';

const NAV: { key: string; icon: React.ReactNode; label: string; permission?: string }[] = [
  { key: '/', icon: <DashboardOutlined />, label: t('nav.dashboard') },
  { key: '/leads', icon: <UserAddOutlined />, label: t('nav.leads') },
  { key: '/accounts', icon: <BankOutlined />, label: t('nav.accounts') },
  { key: '/deals', icon: <FundOutlined />, label: t('nav.deals') },
  { key: '/activities', icon: <ScheduleOutlined />, label: t('nav.activities') },
  { key: '/products', icon: <AppstoreOutlined />, label: t('nav.products') },
  { key: '/audit-logs', icon: <AuditOutlined />, label: t('nav.audit'), permission: 'audit.read' },
  { key: '/users', icon: <TeamOutlined />, label: t('nav.users'), permission: 'user.manage' },
];

/**
 * 根据路径计算当前菜单项。
 * Resolve the selected menu key from the path.
 */
function selectedKey(pathname: string): string {
  const path = pathname.replace(/\/$/, '') || '/';
  return NAV.find((n) => n.key !== '/' && path.startsWith(n.key))?.key ?? '/';
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
          items={NAV.filter((n) => !n.permission || me.permissions.includes(n.permission)).map((n) => ({
            key: n.key,
            icon: n.icon,
            label: <Link href={n.key}>{n.label}</Link>,
          }))}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{ background: '#fff', padding: '0 24px', display: 'flex', alignItems: 'center', gap: 16, borderBottom: '1px solid #e8ecf2' }}
        >
          <GlobalSearch />
          <div style={{ flex: 1 }} />
          <Typography.Text type="secondary">{me.organization.name}</Typography.Text>
          {me.isDemo && <Tag color="orange">{t('demo.badge')}</Tag>}
          <Tag color="blue" data-testid="current-role">
            {tEnum('role', me.role)}
          </Tag>
          <Dropdown
            menu={{
              items: [{ key: 'logout', icon: <LogoutOutlined />, label: t('nav.logout') }],
              onClick: async () => {
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
