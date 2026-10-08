"use client";

// sidebar-16 NavMain, shaped for this app: the parent button is a NAVIGATION
// (it opens the section's own landing view), and the chevron is the ONLY
// thing that expands the sub-tab list. Collapsible is CONTROLLED here: the
// section is expanded when it is active unless the user folded it by hand,
// so the parent's own click never fights the chevron.
import { ChevronRight, type LucideIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";

export type NavItem = {
  id: string;
  title: string;
  icon: LucideIcon;
  items?: { id: string; title: string }[];
};

export function NavMain({
  items,
  activeId,
  activeSubId,
  isOpen,
  onToggle,
  onPick,
  onPickSub,
}: {
  items: NavItem[];
  activeId: string;
  activeSubId: string | null;
  isOpen: (item: NavItem) => boolean;
  onToggle: (id: string, open: boolean) => void;
  onPick: (id: string) => void;
  onPickSub: (id: string, subId: string) => void;
}) {
  return (
    <SidebarGroup>
      <SidebarMenu>
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <Collapsible
              key={item.id}
              asChild
              open={isOpen(item)}
              onOpenChange={(open) => onToggle(item.id, open)}
            >
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={active}
                  tooltip={item.title}
                >
                  <button type="button" onClick={() => onPick(item.id)}>
                    <item.icon />
                    <span>{item.title}</span>
                  </button>
                </SidebarMenuButton>
                {item.items?.length ? (
                  <>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuAction
                        aria-label={`Toggle ${item.title}`}
                        className="data-[state=open]:rotate-90"
                      >
                        <ChevronRight />
                      </SidebarMenuAction>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        {item.items.map((sub) => (
                          <SidebarMenuSubItem key={sub.id}>
                            <SidebarMenuSubButton
                              asChild
                              isActive={sub.id === activeSubId}
                            >
                              <button type="button" onClick={() => onPickSub(item.id, sub.id)}>
                                <span>{sub.title}</span>
                              </button>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </>
                ) : null}
              </SidebarMenuItem>
            </Collapsible>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}
