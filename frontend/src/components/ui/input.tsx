import * as React from "react"
import { cn } from "@/lib/utils"

/** Flat, 1px border, 2px radius -- the same surface as the numeric entries. */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full rounded-sm border border-line bg-void px-2.5 text-sm text-ink outline-none transition-colors",
        "placeholder:text-ink-faint selection:bg-ink selection:text-void",
        "focus-visible:border-line-bright focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-hot",
        className,
      )}
      {...props}
    />
  )
}

export { Input }
