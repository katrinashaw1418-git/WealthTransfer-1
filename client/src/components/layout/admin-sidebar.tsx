import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  ClipboardList,
  Mail,
  Users,
  Link2,
  ScrollText,
  Shield,
  Package,
  ListChecks,
  FileText,
  ShieldCheck,
  HandCoins,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface AdminSidebarProps {
  open: boolean;
  onClose: () => void;
}

const NAV_ITEMS = [
  { to: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/admin/applications", label: "Applications", icon: ClipboardList },
  { to: "/admin/registration-invites", label: "Registration Invites", icon: Mail },
  { to: "/admin/advisers", label: "Advisers", icon: Users },
  { to: "/admin/adviser-clients", label: "Adviser-Client Links", icon: Link2 },
  { to: "/admin/products", label: "Investment Products", icon: Package },
  { to: "/admin/instructions", label: "Instructions", icon: ListChecks },
  { to: "/admin/reports", label: "Report Requests", icon: FileText },
  { to: "/admin/fee-consents", label: "Fee Consents", icon: HandCoins },
  { to: "/admin/fees", label: "Fee Engine (Gate A)", icon: HandCoins },
  { to: "/admin/compliance", label: "Compliance", icon: ShieldCheck },
  { to: "/admin/audit-logs", label: "Audit Log", icon: ScrollText },
] as const;

export default function AdminSidebar({ open, onClose }: AdminSidebarProps) {
  const [location] = useLocation();

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-30 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={cn(
          "fixed lg:sticky top-0 left-0 z-40 h-screen w-64 bg-violet-950 text-white",
          "transform transition-transform duration-200 ease-in-out lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
        data-testid="sidebar-admin"
      >
        <div className="px-5 pt-5 pb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-violet-300" />
            <div>
              <div className="text-sm font-semibold leading-tight">AMAX Admin</div>
              <div className="text-[11px] text-violet-300 leading-tight">
                AFSL operations
              </div>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden text-white hover:bg-violet-900"
            onClick={onClose}
            data-testid="button-close-sidebar"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        <nav className="px-3 mt-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = location === item.to || location.startsWith(item.to + "/");
            return (
              <Link key={item.to} href={item.to}>
                <a
                  onClick={onClose}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                    isActive
                      ? "bg-violet-800 text-white"
                      : "text-violet-200 hover:bg-violet-900 hover:text-white",
                  )}
                  data-testid={`link-admin-${item.to.split("/").pop()}`}
                >
                  <Icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </a>
              </Link>
            );
          })}
        </nav>

        <div className="absolute bottom-4 left-5 right-5 text-[10px] text-violet-400 leading-snug">
          Admin actions are recorded in the audit log. Phase 3 (10C — fee engine, real money) remains gated.
        </div>
      </aside>
    </>
  );
}
