import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
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
  ChevronRight
} from "lucide-react";
import amaxLogo from "@assets/AMAX_LOGO_BLUE_1776303944567.jpg";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: Home },
  { name: "Portfolio Overview", href: "/wallets", icon: Briefcase },
  { name: "Portfolio", href: "/portfolio", icon: PieChart },
  { name: "Investments", href: "/investments", icon: Building2 },
  { name: "Market Insights", href: "/ai-advisory", icon: Bot },
  { name: "Activity", href: "/transactions", icon: History },
  { name: "Compliance", href: "/compliance", icon: Shield },
  { name: "Legal", href: "/legal", icon: Scale },
];

function SidebarContent() {
  const [location] = useLocation();

  return (
    <div className="flex flex-col h-full">
      {/* Logo Section */}
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center space-x-3">
          <img src={amaxLogo} alt="AMAX Wealth" className="w-12 h-12 rounded-lg" />
          <div>
            <h1 className="text-lg font-bold text-gray-900">AMAX WEALTH</h1>
            <p className="text-xs text-gray-500">Investments / Advice</p>
          </div>
        </div>
      </div>

      {/* Navigation Menu */}
      <nav className="flex-1 p-4 space-y-2">
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
                    ? "bg-primary text-white hover:bg-primary/90" 
                    : "text-gray-700 hover:bg-gray-100"
                )}
              >
                <Icon className="w-4 h-4 mr-3" />
                {item.name}
              </Button>
            </Link>
          );
        })}
      </nav>

      {/* User Profile Section */}
      <div className="p-4 border-t border-gray-200">
        <div className="flex items-center space-x-3 p-4 bg-gray-50 rounded-lg">
          <div className="w-8 h-8 bg-primary rounded-full flex items-center justify-center">
            <User className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-gray-900">Wise Investor</p>
            <p className="text-xs text-gray-500">Premium Client</p>
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
      {/* Desktop Sidebar */}
      <div className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 lg:bg-white lg:shadow-lg lg:border-r lg:border-gray-200 lg:z-50">
        <SidebarContent />
      </div>

      {/* Mobile Sidebar */}
      <Sheet open={isOpen} onOpenChange={onClose}>
        <SheetContent side="left" className="p-0 w-64">
          <SidebarContent />
        </SheetContent>
      </Sheet>
    </>
  );
}
