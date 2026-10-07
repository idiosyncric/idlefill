import * as React from "react";
import { Separator as SeparatorPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/* shadcn/ui Separator (registry shape). The Hairline token does the
   work: the settings rows separate by 1px rule, never by border
   emphasis (DESIGN.md panels rule). */

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
