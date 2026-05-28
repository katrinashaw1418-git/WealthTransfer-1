import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  Home,
  Wallet,
  History,
  Shield,
  User,
  ChevronRight,
  ArrowRightLeft,
  Bitcoin,
} from "lucide-react";
import { useAuth } from "@/contexts/auth";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

const NAVY = "#002366";

const navigation = [
  { name: "Dashboard",                  href: "/dashboard",    icon: Home           },
  { name: "Transfer In / Transfer Out", href: "/wallets",      icon: Wallet         },
  { name: "FX Conversion",              href: "/fx-exchange",  icon: ArrowRightLeft },
  { name: "Digital Asset Exchange",     href: "/crypto",       icon: Bitcoin        },
  { name: "Transactions",               href: "/transactions", icon: History        },
  { name: "Compliance",                 href: "/compliance",   icon: Shield         },
];

function SidebarContent({ onNavClick }: { onNavClick?: () => void }) {
  const [location, navigate] = useLocation();
  const { user } = useAuth();

  function handleNav(href: string) {
    navigate(href);
    onNavClick?.();
  }

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Logo Section — Royal Navy bar at top */}
      <div className="px-5 py-4 flex items-center gap-3" style={{ background: NAVY, borderBottom: `1px solid ${NAVY}` }}>
        <img src="/amax-global-fx-logo.png" alt="AMAX Global FX" className="h-9 w-auto flex-shrink-0" />
      </div>

      {/* Navigation Menu */}
      <nav className="flex-1 p-4 space-y-1">
        {navigation.map((item) => {
          const Icon = item.icon;
          const isActive = location === item.href;

          return (
            <Button
              key={item.name}
              variant="ghost"
              className={cn(
                "w-full justify-start text-left font-medium transition-colors",
                isActive
                  ? "text-white hover:text-white"
                  : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
              )}
              style={isActive ? { background: NAVY } : {}}
              onClick={() => handleNav(item.href)}
            >
              <Icon className="w-4 h-4 mr-3 flex-shrink-0" />
              {item.name}
            </Button>
          );
        })}
      </nav>

      {/* Regulatory labels */}
      <div className="px-4 pb-2 space-y-1">
        <p className="text-[10px] text-gray-400 px-3">FX &amp; Remittance — AUSTRAC registered</p>
        <p className="text-[10px] text-gray-400 px-3">DCE — AUSTRAC registered</p>
      </div>

      {/* User Profile Section */}
      <div className="p-4 border-t border-gray-200">
        <div className="flex items-center space-x-3 p-4 bg-gray-50 rounded-lg">
          <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: NAVY }}>
            <User className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">
              {user ? `${user.firstName} ${user.lastName}` : "Guest"}
            </p>
            <p className="text-xs text-gray-500">
              {user?.email === "demo@amaxglobal.com.au"
                ? "Simulation Account"
                : user?.kycStatus === "verified" ? "Verified Client" : "Client"}
            </p>
          </div>
          <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
        </div>
      </div>
    </div>
  );
}

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  return (
    <>
      {/* Desktop Sidebar */}
      <div className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 lg:bg-white lg:shadow-lg lg:border-r lg:border-gray-200 lg:z-50">
        <SidebarContent />
      </div>

      {/* Mobile Sidebar */}
      <Sheet open={isOpen} onOpenChange={onClose}>
        <SheetContent side="left" className="p-0 w-64">
          <SidebarContent onNavClick={onClose} />
        </SheetContent>
      </Sheet>
    </>
  );
}
