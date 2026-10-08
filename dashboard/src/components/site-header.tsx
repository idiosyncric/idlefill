"use client";

// sidebar-16 SiteHeader: the toggle that folds the sidebar to icons, plus
// the breadcrumb for where you are, plus the global idle/busy word.
import { PanelLeftIcon } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useSidebar } from "@/components/ui/sidebar";

export function SiteHeader({
  crumb,
  globalWord,
}: {
  crumb: string[];
  globalWord: { label: string; cls: string };
}) {
  const { toggleSidebar } = useSidebar();
  return (
    <header className="flex h-12 w-full items-center gap-2 border-b border-border bg-background px-4">
      <Button
        className="size-8"
        variant="ghost"
        size="icon"
        aria-label="Toggle sidebar"
        onClick={toggleSidebar}
      >
        <PanelLeftIcon />
      </Button>
      <Separator orientation="vertical" className="mr-2 h-4" />
      <Breadcrumb className="hidden sm:block">
        <BreadcrumbList className="text-[12px]">
          {crumb.map((c, i) => (
            <BreadcrumbItem key={c} className="flex items-center gap-2">
              {i > 0 && <BreadcrumbSeparator />}
              {i === crumb.length - 1 ? <BreadcrumbPage>{c}</BreadcrumbPage> : <span className="text-dim">{c}</span>}
            </BreadcrumbItem>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      <span className={`ml-auto text-[12px] font-semibold ${globalWord.cls}`}>{globalWord.label}</span>
    </header>
  );
}
