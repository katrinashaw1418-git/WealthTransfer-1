import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import AdviserSidebar from "./adviser-sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/auth";
import { Menu, Search, Shield, LogOut } from "lucide-react";
import NotificationsPopover from "@/components/notifications-popover";
import WriteKillSwitchBanner from "@/components/write-kill-switch-banner";

interface AdviserLayoutProps {
  children: React.ReactNode;
}

export default function AdviserLayout({ children }: AdviserLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [, navigate] = useLocation();
  // useSearch subscribes to the live search-string portion of the URL —
  // wouter's useLocation only tracks pathname, so without this the topbar
  // would not pick up ?q= changes when only the query string moves.
  const searchString = useSearch();
  const { user, logout } = useAuth();

  // If the URL has ?q=foo (e.g. arriving on /adviser/clients?q=alex), reflect
  // it in the search box so the field stays in sync with the filtered view.
  useEffect(() => {
    const params = new URLSearchParams(searchString);
    const q = params.get("q") ?? "";
    setSearch(q);
  }, [searchString]);

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = search.trim();
    if (trimmed.length === 0) {
      navigate("/adviser/clients");
    } else {
      navigate(`/adviser/clients?q=${encodeURIComponent(trimmed)}`);
    }
  };

  const initials =
    (user?.firstName?.[0] ?? "") + (user?.lastName?.[0] ?? "") ||
    user?.username?.slice(0, 2).toUpperCase() ||
    "AR";

  return (
    <div className="flex min-h-screen bg-slate-50">
      <AdviserSidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col lg:ml-64 min-w-0">
        {/* Task #155 — visible above the topbar so a paused environment is
            obvious before the adviser tries a write that would 503. */}
        <WriteKillSwitchBanner />
        {/* Top bar */}
        <header
          className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-sm"
          data-testid="adviser-topbar"
        >
          <div className="flex items-center gap-3 px-4 sm:px-6 h-16">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setSidebarOpen(true)}
              data-testid="button-open-sidebar"
            >
              <Menu className="h-5 w-5" />
            </Button>

            {/* Search */}
            <form onSubmit={submitSearch} className="flex-1 max-w-xl">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search clients by name or email…"
                  className="pl-9 bg-slate-50 border-slate-200 focus:bg-white"
                  data-testid="input-adviser-search"
                />
              </div>
            </form>

            <div className="flex items-center gap-2 sm:gap-3 ml-auto">
              {/* Role badge */}
              <Badge
                variant="outline"
                className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 border-slate-300 bg-white text-slate-700"
                data-testid="badge-role"
              >
                <Shield className="h-3 w-3" />
                Authorised Representative
              </Badge>

              <NotificationsPopover />

              {/* User pill */}
              <div className="hidden sm:flex items-center gap-2 pl-3 border-l border-slate-200">
                <div className="w-8 h-8 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs font-semibold">
                  {initials}
                </div>
                <div className="text-left">
                  <p className="text-sm font-semibold text-slate-900 leading-tight" data-testid="topbar-user-name">
                    {user?.firstName ? `${user.firstName} ${user.lastName ?? ""}`.trim() : user?.username}
                  </p>
                  <p className="text-[11px] text-slate-500 leading-tight">Adviser</p>
                </div>
              </div>

              <Button
                variant="ghost"
                size="icon"
                onClick={() => logout()}
                title="Sign out"
                aria-label="Sign out"
                data-testid="button-logout"
                className="text-slate-500 hover:text-red-600"
              >
                <LogOut className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto" data-testid="adviser-main">
          {children}
        </main>
      </div>
    </div>
  );
}
