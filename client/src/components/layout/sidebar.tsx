import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useAuth } from "@/contexts/auth";
import {
  Home,
  PieChart,
  Bot,
  Target,
  FileText,
  UserCog,
  Scale,
  User,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import amaxLogo from "@assets/AMAX_LOGO_BLUE_1776303944567.jpg";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
}

// -----------------------------------------------------------------------------
// Investor hub navigation only. This `Sidebar` mounts from `layout.tsx`, which
// is used exclusively by `ClientApp` in `App.tsx`. Authenticated advisers never
// render `ClientApp` — they always get `AdviserApp` → `AdviserLayout` →
// `AdviserSidebar` for all `/adviser/*` routes (Slice 6 Task 1).
// -----------------------------------------------------------------------------

const clientNav: NavItem[] = [
  { name: "Dashboard", href: "/dashboard", icon: Home },
  { name: "Portfolio", href: "/portfolio", icon: PieChart },
  { name: "AI Insights", href: "/ai-insights", icon: Bot },
  { name: "Goals", href: "/goals", icon: Target },
  { name: "Reports", href: "/reports", icon: FileText },
  { name: "Account", href: "/account", icon: UserCog },
];

/**
 * @deprecated Unreachable at runtime with current routing. Do not extend.
 * `ProtectedApp` assigns `role === "adviser"` to `AdviserApp` only (never
 * `ClientApp` / this sidebar). Adviser navigation lives in
 * `components/layout/adviser-sidebar.tsx` behind `AdviserLayout` exclusively.
 * Kept temporarily so the obsolete branch remains visible to grep/review;
 * remove when cleaning dead code.
 */
const adviserNav: NavItem[] = [
  { name: "Dashboard", href: "/adviser/dashboard", icon: Home },
  { name: "Clients", href: "/adviser/clients", icon: User },
  { name: "AI Planning", href: "/adviser/ai-planning", icon: Bot },
  { name: "Reports", href: "/adviser/reports", icon: FileText },
  { name: "Compliance", href: "/adviser/compliance", icon: Scale },
];

function SidebarContent() {
  const [location] = useLocation();
  const { user } = useAuth();

  // Slice 6: `isAdviser` is always false when this component renders (see file
  // header). Kept so `clientNav` / `adviserNav` typing stays explicit until dead
  // adviser branch removal.
  const isAdviser = user?.role === "adviser";
  const navigation = isAdviser ? adviserNav : clientNav;

  // Show real user details (no more hardcoded "Wise Investor / Premium Client").
  const displayName =
    user && (user.firstName || user.lastName)
      ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim()
      : user?.username ?? "Account";

  // Task #336 — the previous "Premium Client" / "Standard Client" generic
  // label gave investors no signal about their actual onboarding state.
  // The portal's compliance posture is:
  //   - retail/standard tier with KYC verified → still pending the
  //     wholesale-eligibility (sophisticated investor / s.708) sign-off,
  //     so we surface that the upgrade is in progress.
  //   - hnwi / professional / wholesale tiers with KYC verified → already
  //     classified as wholesale; advisers can transact accordingly.
  //   - KYC not yet verified → show a pending state rather than implying
  //     verified status of any kind.
  const wholesaleTiers = new Set(["hnwi", "professional", "wholesale"]);
  let subLabel: string;
  if (isAdviser) {
    subLabel = "Adviser";
  } else if (user?.kycStatus !== "verified") {
    subLabel = "KYC verification pending";
  } else if (user?.userTier && wholesaleTiers.has(user.userTier)) {
    subLabel = "Wholesale client verified";
  } else {
    subLabel = "Tier 1 verified · Wholesale upgrade in progress";
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center space-x-3">
          <img src={amaxLogo} alt="AMAX Wealth" className="w-12 h-12 rounded-lg" />
          <div>
            <h1 className="text-lg font-bold text-gray-900">AMAX WEALTH</h1>
            <p className="text-xs text-gray-500">
              {isAdviser ? "Adviser portal" : "Advice & reporting"}
            </p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-4 space-y-2" data-testid={isAdviser ? "nav-adviser" : "nav-client"}>
        {navigation.map((item) => {
          const Icon = item.icon;
          const isActive = location === item.href;
          return (
            <Link key={item.name} href={item.href}>
              <Button
                variant={isActive ? "default" : "ghost"}
                className={cn(
                  "w-full justify-start text-left font-medium",
                  isActive
                    ? "bg-sky-500 text-white hover:bg-sky-600"
                    : "text-gray-700 hover:bg-gray-100",
                )}
                data-testid={`nav-${item.href.replace(/\//g, "-")}`}
              >
                <Icon className="w-4 h-4 mr-3" />
                {item.name}
              </Button>
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-gray-200">
        <div className="flex items-center space-x-3 p-4 bg-gray-50 rounded-lg">
          <div className="w-8 h-8 bg-sky-500 rounded-full flex items-center justify-center">
            <User className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate" data-testid="sidebar-user-name">
              {displayName}
            </p>
            <p className="text-xs text-gray-500 truncate">{subLabel}</p>
          </div>
          <ChevronRight className="w-4 h-4 text-gray-400" />
        </div>
      </div>
    </div>
  );
}

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  return (
    <>
      <div className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 lg:bg-white lg:shadow-lg lg:border-r lg:border-gray-200 lg:z-50">
        <SidebarContent />
      </div>
      <Sheet open={isOpen} onOpenChange={onClose}>
        <SheetContent side="left" className="p-0 w-64">
          <SidebarContent />
        </SheetContent>
      </Sheet>
    </>
  );
}
