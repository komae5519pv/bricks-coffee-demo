import { createBrowserRouter, RouterProvider, NavLink, Outlet } from 'react-router';
import { useEffect, useState } from 'react';
import {
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  useIsMobile,
} from '@databricks/appkit-ui/react';
import { Activity, BarChart3, ChefHat, ClipboardList, Coffee, Menu, Settings2 } from 'lucide-react';
import { api, type Me } from './lib/api';
import { OrderPage } from './pages/OrderPage';
import { MyOrdersPage } from './pages/MyOrdersPage';
import { BoardPage } from './pages/BoardPage';
import { MenuAdminPage } from './pages/MenuAdminPage';
import { HistoryPage } from './pages/HistoryPage';
import { StatusPage } from './pages/StatusPage';

type NavLinkClassFn = (props: { isActive: boolean }) => string;

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

const mobileNavLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

function NavLinks({
  className,
  linkClass,
  me,
  onClick,
}: {
  className?: string;
  linkClass: NavLinkClassFn;
  me: Me | null;
  onClick?: () => void;
}) {
  return (
    <nav className={className}>
      <NavLink to="/" end className={linkClass} onClick={onClick}>
        <Coffee className="h-4 w-4" /> 注文する
      </NavLink>
      <NavLink to="/orders" className={linkClass} onClick={onClick}>
        <ClipboardList className="h-4 w-4" /> マイ注文
      </NavLink>
      {me?.is_staff && (
        <>
          <NavLink to="/board" className={linkClass} onClick={onClick}>
            <ChefHat className="h-4 w-4" /> キッチンボード
          </NavLink>
          <NavLink to="/admin/menu" className={linkClass} onClick={onClick}>
            <Settings2 className="h-4 w-4" /> メニュー管理
          </NavLink>
        </>
      )}
      <NavLink to="/history" className={linkClass} onClick={onClick}>
        <BarChart3 className="h-4 w-4" /> 売上・履歴
      </NavLink>
      <NavLink to="/status" className={linkClass} onClick={onClick}>
        <Activity className="h-4 w-4" /> ステータス
      </NavLink>
    </nav>
  );
}

function Layout() {
  const isMobile = useIsMobile();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
  }, []);

  // Close the mobile nav when the layout switches to desktop: state is
  // adjusted during rendering (React-sanctioned) instead of in an effect.
  if (!isMobile && mobileNavOpen) {
    setMobileNavOpen(false);
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-4 md:px-6 py-3 flex items-center gap-4">
        <h1 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Coffee className="h-5 w-5" /> DAIWT Coffee
        </h1>
        <NavLinks className="hidden md:flex gap-1" linkClass={navLinkClass} me={me} />
        <div className="ml-auto flex items-center gap-3">
          {me && (
            <span className="hidden md:inline text-xs text-muted-foreground">
              {me.email}
              {me.is_staff && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded bg-primary/10 text-primary">スタッフ</span>
              )}
            </span>
          )}
          <div className="md:hidden">
            <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
              <Button variant="ghost" size="icon" onClick={() => setMobileNavOpen(true)}>
                <Menu className="h-5 w-5" />
                <span className="sr-only">Open navigation</span>
              </Button>
              <SheetContent side="left">
                <SheetHeader>
                  <SheetTitle>DAIWT Coffee</SheetTitle>
                </SheetHeader>
                <NavLinks
                  className="flex flex-col gap-1"
                  linkClass={mobileNavLinkClass}
                  me={me}
                  onClick={() => setMobileNavOpen(false)}
                />
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-6">
        <Outlet context={me} />
      </main>
    </div>
  );
}

function BoardRoute() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
  }, []);
  return <BoardPage me={me} />;
}

function MenuAdminRoute() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
  }, []);
  return <MenuAdminPage me={me} />;
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <OrderPage /> },
      { path: '/orders', element: <MyOrdersPage /> },
      { path: '/board', element: <BoardRoute /> },
      { path: '/admin/menu', element: <MenuAdminRoute /> },
      { path: '/history', element: <HistoryPage /> },
      { path: '/status', element: <StatusPage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
