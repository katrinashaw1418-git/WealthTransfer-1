import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { useAuth } from "@/contexts/auth";
import {
  Home,
  Users,
  Building2,
  ClipboardCheck,
  ListChecks,
  FileText,
  HandCoins,
  Coins,
  TrendingUp,
  Scale,
  User,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import amaxLogo from "@assets/DARK_BLUE_LOGO_1777194543796.jpg";

interface AdviserSidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  hint?: string;
}

interface NavSection {
  heading: string;
  items: NavItem[];
}

const adviserSections: NavSection[] = [
  {
    heading: "Practice",
    items: [
      { name: "Dashboard", href: "/adviser/dashboard", icon: Home },
      { name: "Workflow", href: "/adviser/workflow", icon: ListChecks, hint: "Tasks + pending consents" },
      { name: "Business", href: "/adviser/business", icon: TrendingUp, hint: "Book snapshot" },
    ],
  },
  {
    heading: "Clients",
    items: [
      { name: "Client book", href: "/adviser/clients", icon: Users },
      { name: "Investment products", href: "/adviser/products", icon: Building2 },
      { name: "Instructions", href: "/adviser/instructions", icon: ClipboardCheck },
      { name: "Fee consents", href: "/adviser/fee-consents", icon: HandCoins, hint: "DBFO requests + signed" },
      { name: "Fee engine", href: "/adviser/fees", icon: HandCoins, hint: "Read-only — Gate A" },
    ],
  },
  {
    heading: "Operations",
    items: [
      { name: "Reports", href: "/adviser/reports", icon: FileText },
      { name: "Legal & compliance", href: "/legal", icon: Scale },
    ],
  },
];

function SidebarBody() {
  const [location] = useLocation();
  const { user } = useAuth();

  const displayName =
    user && (user.firstName || user.lastName)
      ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim()
      : user?.username ?? "Adviser";

  return (
    <div className="flex flex-col h-full bg-slate-900 text-slate-100">
      {/* Brand */}
      <div className="px-6 py-5 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <img src={amaxLogo} alt="AMAX Wealth" className="w-11 h-11 rounded-md" />
          <div>
            <h1 className="text-base font-bold tracking-wide text-white">AMAX WEALTH</h1>
            <p className="text-[11px] uppercase tracking-wider text-white/80">Adviser Portal</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav
        className="flex-1 px-3 py-4 space-y-5 overflow-y-auto"
        data-testid="nav-adviser"
      >
        {adviserSections.map((section) => (
          <div key={section.heading} className="space-y-1">
            <p className="px-3 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              {section.heading}
            </p>
            {section.items.map((item) => {
              const Icon = item.icon;
              const isActive =
                location === item.href ||
                (item.href !== "/adviser/dashboard" && location.startsWith(item.href + "/"));
              return (
                <Link key={item.name} href={item.href}>
                  <Button
                    variant="ghost"
                    className={cn(
                      "w-full justify-start text-left font-medium gap-3 h-10 rounded-md",
                      isActive
                        ? "bg-white/10 text-white hover:bg-white/15 hover:text-white"
                        : "text-slate-300 hover:bg-slate-800 hover:text-white",
                    )}
                    data-testid={`nav-${item.href.replace(/\//g, "-")}`}
                  >
                    <Icon className="w-4 h-4 flex-shrink-0" />
                    <span className="truncate">{item.name}</span>
                  </Button>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* User pill */}
      <div className="p-4 border-t border-slate-800">
        <div className="flex items-center gap-3 p-3 bg-slate-800/60 rounded-lg">
          <div className="w-8 h-8 bg-white rounded-full flex items-center justify-center">
            <User className="w-4 h-4 text-slate-900" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white truncate" data-testid="adviser-sidebar-user-name">
              {displayName}
            </p>
            <p className="text-[11px] text-slate-400 truncate">Authorised Representative</p>
          </div>
          <ChevronRight className="w-4 h-4 text-slate-500" />
        </div>
      </div>
    </div>
  );
}

export default function AdviserSidebar({ isOpen, onClose }: AdviserSidebarProps) {
  return (
    <>
      <div
        className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 lg:z-40 lg:shadow-xl"
        data-testid="adviser-sidebar"
      >
        <SidebarBody />
      </div>
      <Sheet open={isOpen} onOpenChange={onClose}>
        <SheetContent side="left" className="p-0 w-64 bg-slate-900 border-slate-800">
          <VisuallyHidden>
            <SheetTitle>Adviser navigation</SheetTitle>
          </VisuallyHidden>
          <SidebarBody />
        </SheetContent>
      </Sheet>
    </>
  );
}
