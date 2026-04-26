import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useAuth } from "@/contexts/auth";
import {
  Home,
  Briefcase,
  PieChart,
  Bot,
  History,
  Shield,
  Building2,
  Scale,
  User,
  ChevronRight,
  Users,
  ClipboardList,
  ClipboardCheck,
  FileText,
  Receipt,
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
// Two distinct nav profiles. We keep them as separate constants (rather than
// filtering one shared list) so it's obvious in code review what each role
// can navigate to.
// -----------------------------------------------------------------------------
const clientNav: NavItem[] = [
  { name: "Dashboard", href: "/dashboard", icon: Home },
  { name: "Portfolio Overview", href: "/wallets", icon: Briefcase },
  { name: "Portfolio", href: "/portfolio", icon: PieChart },
  { name: "Investments", href: "/investments", icon: Building2 },
  { name: "Market Insights", href: "/ai-advisory", icon: Bot },
  { name: "Activity", href: "/transactions", icon: History },
  { name: "KYC", href: "/compliance", icon: Shield },
  { name: "Fee Consents", href: "/client/fee-consents", icon: Receipt },
  { name: "Your Fees", href: "/client/fees", icon: Receipt },
  { name: "Legal & Compliance", href: "/legal", icon: Scale },
];

const adviserNav: NavItem[] = [
  { name: "Dashboard", href: "/adviser/dashboard", icon: Home },
  { name: "Clients", href: "/adviser/clients", icon: Users },
  { name: "Investment Products", href: "/adviser/products", icon: Building2 },
  { name: "Instructions", href: "/adviser/instructions", icon: ClipboardCheck },
  { name: "Tasks", href: "/adviser/tasks", icon: ClipboardList },
  { name: "Reports", href: "/adviser/reports", icon: FileText },
  { name: "Legal & Compliance", href: "/legal", icon: Scale },
];

function SidebarContent() {
  const [location] = useLocation();
  const { user } = useAuth();

  const isAdviser = user?.role === "adviser";
  const navigation = isAdviser ? adviserNav : clientNav;

  // Show real user details (no more hardcoded "Wise Investor / Premium Client").
  const displayName =
    user && (user.firstName || user.lastName)
      ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim()
      : user?.username ?? "Account";
  const subLabel = isAdviser
    ? "Adviser"
    : user?.userTier
      ? `${user.userTier.charAt(0).toUpperCase()}${user.userTier.slice(1)} Client`
      : "Client";

  return (
    <div className="flex flex-col h-full">
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center space-x-3">
          <img src={amaxLogo} alt="AMAX Wealth" className="w-12 h-12 rounded-lg" />
          <div>
            <h1 className="text-lg font-bold text-gray-900">AMAX WEALTH</h1>
            <p className="text-xs text-gray-500">
              {isAdviser ? "Adviser Portal" : "Investments / Advice"}
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
