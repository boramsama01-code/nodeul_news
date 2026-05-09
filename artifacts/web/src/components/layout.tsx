import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, DownloadCloud, FileText, BarChart2, Menu } from "lucide-react";
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
];

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const [isOpen, setIsOpen] = useState(false);

  const NavLinks = () => (
    <nav className="flex flex-col gap-1 p-4">
      {navItems.map((item) => {
        const isActive = location === item.href;
        return (
          <Link key={item.href} href={item.href}>
            <div
              className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer ${
                isActive
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
              onClick={() => setIsOpen(false)}
            >
              <item.icon className="w-4 h-4" />
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
      <aside className="hidden md:flex flex-col w-64 border-r bg-card shrink-0">
        <div className="p-6 border-b h-16 flex items-center">
          <h1 className="text-xl font-bold tracking-tight">노들섬 뉴스 모니터</h1>
        </div>
        <NavLinks />
      </aside>

      {/* Mobile Sidebar & Header */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="md:hidden h-16 border-b bg-card flex items-center px-4 shrink-0">
          <Sheet open={isOpen} onOpenChange={setIsOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="-ml-2 mr-2">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <div className="p-6 border-b">
                <h1 className="text-xl font-bold tracking-tight">노들섬 뉴스 모니터</h1>
              </div>
              <NavLinks />
            </SheetContent>
          </Sheet>
          <span className="font-bold">노들섬 뉴스 모니터</span>
        </header>

        {/* Main Content */}
        <main className="flex-1 overflow-auto p-4 md:p-8">
          <div className="max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
