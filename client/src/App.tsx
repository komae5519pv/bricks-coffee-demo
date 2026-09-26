import { createBrowserRouter, RouterProvider, NavLink, Outlet, useLocation } from 'react-router';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  useIsMobile,
} from '@databricks/appkit-ui/react';
import { Activity, BarChart3, ChefHat, ClipboardList, Coffee, Menu, MessageCircle, Settings2 } from 'lucide-react';
import { api, type Me } from './lib/api';
import { CartContext, useCart, useCartState } from './lib/cart-store';
import { BaristaChat } from './components/BaristaChat';
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
  view,
  onClick,
}: {
  className?: string;
  linkClass: NavLinkClassFn;
  /** customer = 注文する/マイ注文 only; staff = 全項目 */
  view: 'customer' | 'staff';
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
      {view === 'staff' && (
        <>
          <NavLink to="/board" className={linkClass} onClick={onClick}>
            <ChefHat className="h-4 w-4" /> キッチンボード
          </NavLink>
          <NavLink to="/admin/menu" className={linkClass} onClick={onClick}>
            <Settings2 className="h-4 w-4" /> メニュー管理
          </NavLink>
          <NavLink to="/history" className={linkClass} onClick={onClick}>
            <BarChart3 className="h-4 w-4" /> 売上・履歴
          </NavLink>
          <NavLink to="/status" className={linkClass} onClick={onClick}>
            <Activity className="h-4 w-4" /> ステータス
          </NavLink>
        </>
      )}
    </nav>
  );
}

function CartProvider({ children }: { children: ReactNode }) {
  const value = useCartState();
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

function Layout() {
  return (
    <CartProvider>
      <LayoutShell />
    </CartProvider>
  );
}

/** lg (1024px) and up: the chat panel is a floating window (below that it
 * is a near-fullscreen sheet and resize handles stay hidden). */
function useIsDesktop() {
  const [desktop, setDesktop] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => setDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return desktop;
}

const PANEL_SIZE_KEY = 'daiwt-chat-panel-size';
const PANEL_MIN_W = 320;
const PANEL_MIN_H = 420;

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}

function readPanelSize(): { w: number; h: number } | null {
  try {
    const raw = localStorage.getItem(PANEL_SIZE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { w?: unknown; h?: unknown };
    if (typeof p.w !== 'number' || typeof p.h !== 'number') return null;
    return {
      w: clamp(p.w, PANEL_MIN_W, window.innerWidth - 48),
      h: clamp(p.h, PANEL_MIN_H, window.innerHeight - 48),
    };
  } catch {
    return null;
  }
}

function LayoutShell() {
  const isMobile = useIsMobile();
  const isDesktop = useIsDesktop();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  // デモ用表示切替: スタッフが「お客さん表示」をプレビューできる(表示だけ。
  // 実際のロール・サーバー側の認可は変わらない)。
  const [previewRole, setPreviewRole] = useState<'customer' | 'staff'>('staff');
  const [chatOpen, setChatOpen] = useState(false);
  const { cart } = useCart();
  const cartCount = cart.reduce((s, l) => s + l.quantity, 0);
  const { pathname } = useLocation();
  const isOrderPage = pathname === '/';

  // Chat panel size: drag-resizable from the left/top edges on desktop
  // (the panel is anchored bottom-right, so those edges grow it). The size
  // persists in localStorage; below lg the sheet layout ignores it.
  const [panelSize, setPanelSize] = useState<{ w: number; h: number } | null>(readPanelSize);
  useEffect(() => {
    if (!panelSize) return;
    try {
      localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(panelSize));
    } catch {
      // private mode etc. — resizing still works, it just doesn't persist
    }
  }, [panelSize]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>, dir: 'left' | 'top' | 'corner') => {
    e.preventDefault();
    const panel = e.currentTarget.closest('[data-chat-panel]');
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = rect.width;
    const startH = rect.height;
    const onMove = (ev: PointerEvent) => {
      const w = clamp(startW + (dir === 'top' ? 0 : startX - ev.clientX), PANEL_MIN_W, window.innerWidth - 48);
      const h = clamp(startH + (dir === 'left' ? 0 : startY - ev.clientY), PANEL_MIN_H, window.innerHeight - 48);
      setPanelSize({ w, h });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
  }, []);

  // Close the mobile nav when the layout switches to desktop: state is
  // adjusted during rendering (React-sanctioned) instead of in an effect.
  if (!isMobile && mobileNavOpen) {
    setMobileNavOpen(false);
  }

  const navView: 'customer' | 'staff' = me?.is_staff ? previewRole : 'customer';

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Global header: sticky on every page (h-14 = 56px; the order tab's
          sticky filter bar offsets itself by this height via top-14).
          z-40 keeps it above content but below the mobile Sheet overlay. */}
      <header className="sticky top-0 z-40 bg-background border-b px-4 md:px-6 h-14 flex items-center gap-4">
        <h1 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Coffee className="h-5 w-5" /> BRICKS COFFEE
        </h1>
        <NavLinks className="hidden lg:flex gap-1" linkClass={navLinkClass} view={navView} />
        <div className="ml-auto flex items-center gap-3">
          {me?.is_staff && (
            <div
              className="flex items-center rounded-md bg-muted p-0.5 text-xs"
              title="デモ用表示切替(プレビュー。実際の権限は変わりません)"
            >
              <button
                className={`px-2 py-1 rounded transition-colors ${
                  previewRole === 'customer' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'
                }`}
                onClick={() => setPreviewRole('customer')}
              >
                お客さん表示
              </button>
              <button
                className={`px-2 py-1 rounded transition-colors ${
                  previewRole === 'staff' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'
                }`}
                onClick={() => setPreviewRole('staff')}
              >
                スタッフ表示
              </button>
            </div>
          )}
          {me && (
            <span className="hidden lg:inline text-xs text-muted-foreground">
              {me.email}
              {me.is_staff && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded bg-primary/10 text-primary">スタッフ</span>
              )}
            </span>
          )}
          <div className="lg:hidden">
            <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
              <Button variant="ghost" size="icon" onClick={() => setMobileNavOpen(true)}>
                <Menu className="h-5 w-5" />
                <span className="sr-only">Open navigation</span>
              </Button>
              <SheetContent side="left">
                <SheetHeader>
                  <SheetTitle>BRICKS COFFEE</SheetTitle>
                </SheetHeader>
                <NavLinks
                  className="flex flex-col gap-1"
                  linkClass={mobileNavLinkClass}
                  view={navView}
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

      {/* Floating barista chat: one instance for the whole app, so the
          conversation (and the panel's open state) survives page navigation.
          The FAB lifts above the mobile floating cart bar when the cart is
          non-empty (the bar is order-page-only). */}
      {!chatOpen && (
        <button
          data-chat-fab
          type="button"
          title="AI バリスタに相談"
          onClick={() => setChatOpen(true)}
          className={`fixed right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full border bg-primary text-primary-foreground shadow-lg transition-all lg:right-6 lg:bottom-6 ${
            isOrderPage && cartCount > 0 ? 'bottom-[4.75rem]' : 'bottom-4'
          }`}
        >
          <MessageCircle className="h-5 w-5" />
        </button>
      )}
      {/* Non-modal overlay: no backdrop and no outside-click close — the
          panel stays open while the user browses the menu and edits the
          cart; only the header's close button dismisses it. Kept mounted
          (hidden) when closed so messages and any in-flight stream survive.
          Below lg it's a near-fullscreen sheet; on desktop it's a floating
          panel at the right edge, drag-resizable from the left/top edges
          (size persists in localStorage). */}
      <div
        data-chat-panel
        style={isDesktop && panelSize ? { width: panelSize.w, height: panelSize.h } : undefined}
        className={`fixed inset-2 z-40 flex-col overflow-hidden rounded-lg border bg-background shadow-xl lg:inset-auto lg:bottom-6 lg:right-6 lg:h-[75vh] lg:max-h-[calc(100vh-3rem)] lg:w-96 xl:w-[420px] ${
          chatOpen ? 'flex' : 'hidden'
        }`}
      >
        <div
          data-resize-handle="left"
          className="absolute left-0 top-0 bottom-0 hidden w-1.5 cursor-ew-resize lg:block"
          style={{ touchAction: 'none' }}
          onPointerDown={(e) => startResize(e, 'left')}
        />
        <div
          data-resize-handle="top"
          className="absolute left-0 right-0 top-0 hidden h-1.5 cursor-ns-resize lg:block"
          style={{ touchAction: 'none' }}
          onPointerDown={(e) => startResize(e, 'top')}
        />
        <div
          data-resize-handle="corner"
          className="absolute left-0 top-0 hidden h-4 w-4 cursor-nwse-resize lg:block"
          style={{ touchAction: 'none' }}
          onPointerDown={(e) => startResize(e, 'corner')}
        />
        <BaristaChat panelOpen={chatOpen} onClose={() => setChatOpen(false)} />
      </div>
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
