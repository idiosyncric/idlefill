import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

/* shadcn/ui Button (registry shape: data-slot/data-variant attrs,
   asChild via Radix Slot). Variants keep the DESIGN.md re-skin: flat
   tonal fills, 1px hairlines, zero shadows, radius-md, and the
   shell's compact control heights (h-7 / h-6), not the registry's
   h-9 marketing sizing. */

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground border border-border hover:bg-card",
        secondary:
          "bg-secondary text-secondary-foreground border border-border hover:bg-card",
        outline:
          "border border-border bg-transparent text-foreground hover:bg-card",
        ghost: "text-foreground hover:bg-card",
        destructive:
          "border border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-7 px-3 text-[13px]",
        sm: "h-6 gap-1 rounded-sm px-2 text-[12px]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
