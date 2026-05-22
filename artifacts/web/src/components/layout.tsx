import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, DownloadCloud, FileText, BarChart2, Menu, Newspaper, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

interface LayoutProps {
  children: React.ReactNode;
}

const navItems = [
  { href: "/", label: "대시보드", icon: LayoutDashboard },
  { href: "/crawl", label: "데이터 수집", icon: DownloadCloud },
  { href: "/articles", label: "기사 목록", icon: FileText },
  { href: "/stats", label: "통계", icon: BarChart2 },
  { href: "/settings", label: "설정", icon: Settings },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-8 h-8 rounded-lg bg-sidebar-primary flex items-center justify-center shrink-0">
        <Newspaper className="w-4 h-4 text-white" />
      </div>
      <div className="flex flex-col leading-none">
        <span className="text-[13px] font-bold text-sidebar-foreground tracking-tight">노들섬</span>
        <span className="text-[10px] text-sidebar-foreground/60 tracking-widest uppercase">News Monitor</span>
      </div>
    </div>
  );
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const [isOpen, setIsOpen] = useState(false);

  const NavLinks = ({ onClose }: { onClose?: () => void }) => (
    <nav className="flex flex-col gap-0.5 p-3">
      {navItems.map((item) => {
        const isActive = location === item.href;
        return (
          <Link key={item.href} href={item.href}>
            <div
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all cursor-pointer text-[13.5px] font-medium ${
                isActive
                  ? "bg-sidebar-primary/20 text-sidebar-primary border border-sidebar-primary/30"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              }`}
              onClick={onClose}
            >
              <item.icon className={`w-4 h-4 shrink-0 ${isActive ? "text-sidebar-primary" : ""}`} />
              <span>{item.label}</span>
            </div>
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen flex w-full bg-background">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex flex-col w-56 bg-sidebar shrink-0 border-r border-sidebar-border">
        <div className="px-5 py-5 border-b border-sidebar-border/60">
          <Logo />
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          <NavLinks />
        </div>
        <div className="px-4 py-4 border-t border-sidebar-border/60">
          <div className="text-[10px] text-sidebar-foreground/40 text-center">
            매일 자정 자동 수집
          </div>
        </div>
      </aside>

      {/* Mobile */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="md:hidden h-14 border-b bg-sidebar flex items-center px-4 shrink-0">
          <Sheet open={isOpen} onOpenChange={setIsOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="-ml-2 mr-3 text-sidebar-foreground hover:bg-sidebar-accent">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-56 p-0 bg-sidebar border-sidebar-border">
              <div className="px-5 py-5 border-b border-sidebar-border/60">
                <Logo />
              </div>
              <div className="py-2">
                <NavLinks onClose={() => setIsOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>
          <Logo />
        </header>

        {/* Main Content */}
        <main className="flex-1 overflow-auto p-4 md:p-6 lg:p-8">
          <div className="max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
