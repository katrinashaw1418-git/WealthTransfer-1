import { useState } from "react";
import AdminSidebar from "./admin-sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/auth";
import { Menu, Shield, LogOut } from "lucide-react";
import WriteKillSwitchBanner from "@/components/write-kill-switch-banner";

interface AdminLayoutProps {
  children: React.ReactNode;
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-slate-50 flex">
      <AdminSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        {/* Task #155 — Always-on banner above the admin chrome when the
            global write kill switch is engaged. The toggle UI lives on the
            dashboard; this banner is the persistent signal. */}
        <WriteKillSwitchBanner />
        <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-4 lg:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setSidebarOpen(true)}
              data-testid="button-open-sidebar"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <Badge variant="outline" className="bg-violet-50 border-violet-200 text-violet-700">
              <Shield className="h-3 w-3 mr-1" />
              Admin portal
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <div className="text-sm font-medium text-slate-900" data-testid="text-admin-name">
                {user?.firstName} {user?.lastName}
              </div>
              <div className="text-xs text-slate-500">{user?.email}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              data-testid="button-logout"
            >
              <LogOut className="h-4 w-4 mr-1" />
              Sign out
            </Button>
          </div>
        </header>
        <main className="flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
