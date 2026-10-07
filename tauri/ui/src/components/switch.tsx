import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/* shadcn/ui Switch (registry shape: data-slot, data-size, Radix
   primitives). Re-skinned to DESIGN.md: a rectangular control on the
   6px radius, canvas fill with a 1px hairline ("controls sink into the
   canvas"), zero shadows. Checked = installed rides Signal Green —
   the Exception-Only Rule keeps every other surface neutral. */

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch inline-flex shrink-0 items-center rounded-md border border-border transition-colors outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55 data-[size=default]:h-4 data-[size=default]:w-7 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[state=checked]:border-ok/40 data-[state=checked]:bg-ok data-[state=unchecked]:bg-secondary",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-xs bg-foreground ring-0 transition-transform group-data-[size=default]/switch:size-3 group-data-[size=sm]/switch:size-2.5 data-[state=checked]:translate-x-[calc(100%-1px)] data-[state=unchecked]:translate-x-[1px]",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
